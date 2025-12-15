---
layout: post
title: 'Build your own X: Xây dựng ORM framework với Go - Phần 2'
date: '2025-06-03 14:30'
excerpt: >-
  Phần 2 trong chuỗi bài về xây dựng ORM framework với Go. Bài viết hướng dẫn cách tạo lớp Dialect để hỗ trợ nhiều loại cơ sở dữ liệu, sử dụng reflection để chuyển đổi struct thành bảng, và triển khai các thao tác quản lý bảng dữ liệu.
comments: false
---

# Phần 2: Chuyển đổi struct thành bảng trong GeeORM

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ hai trong loạt bài hướng dẫn xây dựng ORM framework GeeORM từ đầu bằng Go trong 7 ngày.

## Mục tiêu của bài viết này

- Tạo lớp Dialect để hỗ trợ nhiều loại cơ sở dữ liệu và cô lập sự khác biệt giữa chúng
- Sử dụng reflection để phân tích struct và chuyển đổi thành bảng trong hệ thống quản trị cơ sở dữ liệu
- Triển khai các thao tác tạo và xóa bảng dữ liệu

## 1. Dialect

Các kiểu dữ liệu trong SQL khác với các kiểu dữ liệu trong Go. Ví dụ, kiểu `int`, `int8`, `int16` trong Go đều tương ứng với kiểu `integer` trong SQLite. Do đó, bước đầu tiên trong việc xây dựng ORM là tạo cơ chế chuyển đổi kiểu dữ liệu từ Go sang SQL.

Ngoài ra, mỗi hệ quản trị cơ sở dữ liệu (MySQL, PostgreSQL, SQLite...) có cú pháp SQL riêng. Để ORM framework có thể hoạt động với nhiều loại cơ sở dữ liệu, chúng ta cần tạo một lớp trừu tượng để cô lập những khác biệt này. Lớp trừu tượng này được gọi là "dialect" (phương ngữ).

Đầu tiên, tạo thư mục `dialect` và file `dialect.go` để định nghĩa interface chung:

```go
package dialect

import "reflect"

var dialectsMap = map[string]Dialect{}

type Dialect interface {
    DataTypeOf(typ reflect.Value) string
    TableExistSQL(tableName string) (string, []interface{})
}

func RegisterDialect(name string, dialect Dialect) {
    dialectsMap[name] = dialect
}

func GetDialect(name string) (dialect Dialect, ok bool) {
    dialect, ok = dialectsMap[name]
    return
}
```

Interface `Dialect` định nghĩa hai phương thức cần thiết:

- `DataTypeOf` - Chuyển đổi kiểu dữ liệu Go sang kiểu dữ liệu SQL tương ứng
- `TableExistSQL` - Tạo câu lệnh SQL để kiểm tra xem một bảng có tồn tại không

Hai hàm `RegisterDialect` và `GetDialect` giúp quản lý các dialect khác nhau trong hệ thống. Khi cần hỗ trợ một cơ sở dữ liệu mới, chỉ cần tạo một dialect mới và đăng ký nó.

Tiếp theo, tạo file `sqlite3.go` để triển khai dialect cho SQLite:

```go
package dialect

import (
    "fmt"
    "reflect"
    "time"
)

type sqlite3 struct{}

var _ Dialect = (*sqlite3)(nil)

func init() {
    RegisterDialect("sqlite3", &sqlite3{})
}

func (s *sqlite3) DataTypeOf(typ reflect.Value) string {
    switch typ.Kind() {
    case reflect.Bool:
        return "bool"
    case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32,
        reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uintptr:
        return "integer"
    case reflect.Int64, reflect.Uint64:
        return "bigint"
    case reflect.Float32, reflect.Float64:
        return "real"
    case reflect.String:
        return "text"
    case reflect.Array, reflect.Slice:
        return "blob"
    case reflect.Struct:
        if _, ok := typ.Interface().(time.Time); ok {
            return "datetime"
        }
    }
    panic(fmt.Sprintf("invalid sql type %s (%s)", typ.Type().Name(), typ.Kind()))
}

func (s *sqlite3) TableExistSQL(tableName string) (string, []interface{}) {
    args := []interface{}{tableName}
    return "SELECT name FROM sqlite_master WHERE type='table' and name = ?", args
}
```

Trong triển khai này:
- `DataTypeOf` ánh xạ các kiểu dữ liệu Go sang kiểu dữ liệu SQLite tương ứng
- `TableExistSQL` tạo câu lệnh SQL để kiểm tra sự tồn tại của bảng trong SQLite
- Hàm `init()` tự động đăng ký dialect SQLite khi package được import

Với cách thiết kế này, chúng ta có thể dễ dàng mở rộng framework để hỗ trợ các cơ sở dữ liệu khác như MySQL, PostgreSQL mà không cần thay đổi phần code còn lại.

## 2. Schema

Sau khi đã tạo Dialect để xử lý sự khác biệt giữa các cơ sở dữ liệu, bước tiếp theo là xây dựng thành phần cốt lõi của ORM - chuyển đổi struct Go thành schema cơ sở dữ liệu. Chúng ta cần ánh xạ các thành phần của struct sang các thành phần tương ứng trong bảng dữ liệu.

Để tạo một bảng trong cơ sở dữ liệu, chúng ta cần các thông tin sau:

- Tên bảng → Lấy từ tên struct
- Tên cột và kiểu dữ liệu → Lấy từ tên và kiểu của các trường trong struct
- Ràng buộc (constraints) → Lấy từ struct tags

Ví dụ, với struct Go như sau:

```go
type User struct {
    Name string `geeorm:"PRIMARY KEY"`
    Age  int
}
```

Chúng ta muốn tạo câu lệnh SQL tương ứng:

```sql
CREATE TABLE `User` (`Name` text PRIMARY KEY, `Age` integer);
```

Để làm được điều này, chúng ta tạo package `schema` với file `schema.go`:

```go
package schema

import (
    "geeorm/dialect"
    "go/ast"
    "reflect"
)

// Field đại diện cho một cột trong cơ sở dữ liệu
type Field struct {
    Name string // Tên cột
    Type string // Kiểu dữ liệu SQL
    Tag  string // Ràng buộc (constraints)
}

// Schema đại diện cho một bảng trong cơ sở dữ liệu
type Schema struct {
    Model      interface{} // Struct gốc
    Name       string      // Tên bảng
    Fields     []*Field    // Danh sách các cột
    FieldNames []string    // Danh sách tên cột
    fieldMap   map[string]*Field // Map tên cột -> thông tin cột
}

// GetField trả về thông tin của một cột theo tên
func (schema *Schema) GetField(name string) *Field {
    return schema.fieldMap[name]
}
```

Tiếp theo, chúng ta cần hàm `Parse` để phân tích struct và tạo schema:

```go
func Parse(dest interface{}, d dialect.Dialect) *Schema {
    // Lấy kiểu của struct (bỏ qua con trỏ nếu có)
    modelType := reflect.Indirect(reflect.ValueOf(dest)).Type()
    
    // Khởi tạo schema
    schema := &Schema{
        Model:    dest,
        Name:     modelType.Name(),
        fieldMap: make(map[string]*Field),
    }

    // Duyệt qua tất cả các trường của struct
    for i := 0; i < modelType.NumField(); i++ {
        p := modelType.Field(i)
        // Chỉ xử lý các trường được export (viết hoa)
        if !p.Anonymous && ast.IsExported(p.Name) {
            // Tạo đối tượng Field
            field := &Field{
                Name: p.Name,
                Type: d.DataTypeOf(reflect.Indirect(reflect.New(p.Type))),
            }
            // Đọc tag nếu có
            if v, ok := p.Tag.Lookup("geeorm"); ok {
                field.Tag = v
            }
            // Thêm vào schema
            schema.Fields = append(schema.Fields, field)
            schema.FieldNames = append(schema.FieldNames, p.Name)
            schema.fieldMap[p.Name] = field
        }
    }
    return schema
}
```

Hàm `Parse` sử dụng reflection để:
1. Lấy thông tin về kiểu của struct
2. Duyệt qua từng trường trong struct
3. Chuyển đổi kiểu dữ liệu Go sang kiểu SQL thông qua Dialect
4. Đọc các tag để lấy ràng buộc
5. Lưu trữ thông tin trong đối tượng Schema

Để kiểm tra tính đúng đắn, chúng ta viết test case:

```go
// schema_test.go
type User struct {
    Name string `geeorm:"PRIMARY KEY"`
    Age  int
}

var TestDial, _ = dialect.GetDialect("sqlite3")

func TestParse(t *testing.T) {
    schema := Parse(&User{}, TestDial)
    if schema.Name != "User" || len(schema.Fields) != 2 {
        t.Fatal("failed to parse User struct")
    }
    if schema.GetField("Name").Tag != "PRIMARY KEY" {
        t.Fatal("failed to parse primary key")
    }
}
```

## 3. Session

Để làm việc với schema và quản lý bảng dữ liệu, chúng ta cần mở rộng cấu trúc Session đã tạo ở phần trước:

```go
type Session struct {
    db       *sql.DB
    dialect  dialect.Dialect
    refTable *schema.Schema
    sql      strings.Builder
    sqlVars  []interface{}
}

func New(db *sql.DB, dialect dialect.Dialect) *Session {
    return &Session{
        db:      db,
        dialect: dialect,
    }
}
```

Chúng ta đã thêm hai trường mới vào cấu trúc Session:
- `dialect` - lưu trữ dialect được sử dụng để tương tác với cơ sở dữ liệu
- `refTable` - lưu trữ schema của đối tượng đang được xử lý

Tiếp theo, tạo file `table.go` trong thư mục session để triển khai các thao tác quản lý bảng:

```go
func (s *Session) Model(value interface{}) *Session {
    // nil or different model, update refTable
    if s.refTable == nil || reflect.TypeOf(value) != reflect.TypeOf(s.refTable.Model) {
        s.refTable = schema.Parse(value, s.dialect)
    }
    return s
}

func (s *Session) RefTable() *schema.Schema {
    if s.refTable == nil {
        log.Error("Model is not set")
    }
    return s.refTable
}
```

Phương thức `Model()` nhận một đối tượng và lưu schema của nó vào `refTable`. Để tối ưu hiệu suất, chúng ta chỉ phân tích lại khi cần thiết - khi `refTable` chưa được thiết lập hoặc khi đối tượng mới có kiểu khác với đối tượng hiện tại.

Phương thức `RefTable()` trả về schema hiện tại, kèm theo cảnh báo nếu chưa được thiết lập.

Bây giờ chúng ta có thể triển khai các thao tác cơ bản với bảng dữ liệu:

```go
func (s *Session) CreateTable() error {
    table := s.RefTable()
    var columns []string
    for _, field := range table.Fields {
        columns = append(columns, fmt.Sprintf("%s %s %s", field.Name, field.Type, field.Tag))
    }
    desc := strings.Join(columns, ",")
    _, err := s.Raw(fmt.Sprintf("CREATE TABLE %s (%s);", table.Name, desc)).Exec()
    return err
}

func (s *Session) DropTable() error {
    _, err := s.Raw(fmt.Sprintf("DROP TABLE IF EXISTS %s", s.RefTable().Name)).Exec()
    return err
}

func (s *Session) HasTable() bool {
    sql, values := s.dialect.TableExistSQL(s.RefTable().Name)
    row := s.Raw(sql, values...).QueryRow()
    var tmp string
    _ = row.Scan(&tmp)
    return tmp == s.RefTable().Name
}
```

- `CreateTable()` tạo bảng mới dựa trên schema, kết hợp tên trường, kiểu dữ liệu và các ràng buộc
- `DropTable()` xóa bảng nếu tồn tại
- `HasTable()` kiểm tra xem bảng có tồn tại trong cơ sở dữ liệu không

Để kiểm tra các phương thức này, chúng ta viết test case:

```go
type User struct {
    Name string `geeorm:"PRIMARY KEY"`
    Age  int
}

func TestSession_CreateTable(t *testing.T) {
    s := NewSession().Model(&User{})
    _ = s.DropTable()
    _ = s.CreateTable()
    if !s.HasTable() {
        t.Fatal("Failed to create table User")
    }
}
```

## 4. Engine

Cấu trúc Engine cần được cập nhật để hỗ trợ Dialect, vì constructor của Session giờ đây yêu cầu thêm tham số dialect.

```go
type Engine struct {
    db      *sql.DB
    dialect dialect.Dialect
}

func NewEngine(driver, source string) (e *Engine, err error) {
    // Kết nối đến cơ sở dữ liệu
    db, err := sql.Open(driver, source)
    if err != nil {
        log.Error(err)
        return
    }
    
    // Kiểm tra kết nối còn sống không
    if err = db.Ping(); err != nil {
        log.Error(err)
        return
    }
    
    // Lấy dialect tương ứng với driver
    dial, ok := dialect.GetDialect(driver)
    if !ok {
        log.Errorf("dialect %s Not Found", driver)
        return
    }
    
    // Khởi tạo Engine với db và dialect
    e = &Engine{db: db, dialect: dial}
    log.Info("Connect database success")
    return
}

func (engine *Engine) NewSession() *session.Session {
    return session.New(engine.db, engine.dialect)
}
```

Engine có hai nhiệm vụ chính:
1. Trong hàm `NewEngine`, lấy dialect phù hợp dựa trên tên driver
2. Trong hàm `NewSession`, truyền cả db và dialect vào constructor của Session

## Kết luận

Trong phần 2 này, chúng ta đã xây dựng các thành phần cốt lõi cho việc ánh xạ đối tượng vào bảng dữ liệu:

1) Tạo lớp Dialect để trừu tượng hóa sự khác biệt giữa các hệ quản trị cơ sở dữ liệu, giúp ORM framework có thể hoạt động với nhiều loại database khác nhau.

2) Sử dụng reflection để phân tích cấu trúc struct và chuyển đổi thành schema cơ sở dữ liệu, bao gồm tên bảng, tên cột, kiểu dữ liệu và các ràng buộc.

3) Triển khai các thao tác quản lý bảng như tạo, xóa và kiểm tra sự tồn tại của bảng, đặt nền móng cho các thao tác CRUD trong các phần tiếp theo.

