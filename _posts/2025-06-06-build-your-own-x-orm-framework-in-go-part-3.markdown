---
layout: post
title: 'Build your own X: Xây dựng ORM framework với Go - Phần 3'
date: '2025-06-06 14:30'
excerpt: >-
  Phần 3 trong chuỗi bài về xây dựng ORM framework với Go. Bài viết hướng dẫn cách triển khai các chức năng thêm và truy vấn bản ghi, sử dụng reflection để chuyển đổi giữa đối tượng và dữ liệu trong cơ sở dữ liệu.
comments: false
---

# Phần 3: Thêm và truy vấn bản ghi trong GeeORM

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ ba trong loạt bài hướng dẫn xây dựng ORM framework GeeORM từ đầu bằng Go trong 7 ngày.

## Mục tiêu của bài viết này

- Hướng dẫn cách triển khai chức năng thêm (insert) bản ghi vào cơ sở dữ liệu.
- Giải thích cách sử dụng reflection để chuyển đổi dữ liệu từ cơ sở dữ liệu thành các struct trong Go, phục vụ cho việc truy vấn (select) bản ghi.

## 1. Clause - Xây dựng câu lệnh SQL một cách linh hoạt

Ở phần 3 này, GeeORM bắt đầu xử lý các thao tác phức tạp hơn, đặc biệt là các thao tác truy vấn dữ liệu. Câu lệnh truy vấn SQL thường được tạo thành từ nhiều mệnh đề (clause) khác nhau. Ví dụ, cấu trúc của một câu lệnh SELECT thường như sau:

```sql
SELECT col1, col2, ... FROM table_name WHERE [conditions] GROUP BY col1 HAVING [conditions]
```

### Tại sao cần một hệ thống xây dựng câu lệnh SQL?

Trong SQL, một câu lệnh thường được tạo thành từ nhiều phần nhỏ gọi là "mệnh đề" (tiếng Anh: clause), ví dụ như SELECT, WHERE, ORDER BY, LIMIT,... Mỗi mệnh đề này đóng vai trò riêng trong việc xác định dữ liệu cần truy vấn, lọc, sắp xếp hay giới hạn kết quả.

Việc xây dựng một câu lệnh SQL hoàn chỉnh ngay từ đầu là khó khăn vì:
- Không phải lúc nào cũng cần đầy đủ tất cả các mệnh đề, tuỳ vào từng truy vấn mà có thể có hoặc không có các phần như WHERE, ORDER BY, LIMIT,...
- Thứ tự của các mệnh đề trong câu lệnh SQL phải chính xác, nếu sai thứ tự sẽ gây lỗi cú pháp.
- Mỗi mệnh đề lại có cú pháp riêng biệt, cần được xử lý đúng cách.

Vì vậy, để việc xây dựng và quản lý các câu lệnh SQL phức tạp trở nên đơn giản hơn, chúng ta nên tách riêng việc tạo từng phần nhỏ (mệnh đề) của câu lệnh SQL, như SELECT, WHERE, ORDER BY,... Sau đó, khi cần, chúng ta chỉ việc ghép các phần này lại với nhau để tạo thành một câu lệnh SQL hoàn chỉnh. Cách làm này giúp code rõ ràng, dễ bảo trì và dễ mở rộng khi cần bổ sung thêm các loại mệnh đề mới.

### Triển khai các generator cho từng loại mệnh đề

Để xây dựng từng phần của câu lệnh SQL một cách linh hoạt, chúng ta định nghĩa các hàm generator cho từng loại mệnh đề (clause) như INSERT, VALUES, SELECT, WHERE, LIMIT, ORDER BY,...  
Mỗi generator nhận vào các tham số cần thiết và trả về hai giá trị:
1. Chuỗi SQL tương ứng với mệnh đề
2. Mảng các tham số sẽ được bind vào câu lệnh SQL (dùng cho prepared statement)

> **Bind** là gì?
> Bind trong SQL có nghĩa là "gắn" hoặc "liên kết" các giá trị thực tế vào các vị trí placeholder (thường là dấu `?`) trong câu lệnh SQL.
> Khi sử dụng **prepared statement**, thay vì chèn trực tiếp giá trị vào chuỗi SQL (điều này dễ gây lỗi hoặc lỗ hổng bảo mật), chúng ta sẽ viết câu lệnh với các dấu `?`. Sau đó, bạn truyền một mảng tham số vào để hệ quản trị cơ sở dữ liệu tự động thay thế từng dấu `?` bằng giá trị tương ứng.
> Cách làm này giúp tăng tính an toàn, tránh lỗi **SQL injection** và tối ưu hiệu năng khi thực thi nhiều lần với các giá trị khác nhau.
> **Ví dụ:**
> ```sql
> sql := "SELECT * FROM User WHERE age > ?"
> vars := []interface{}{18}
> ```
> Trong ví dụ này, giá trị 18 sẽ được "bind" vào dấu ? trong câu lệnh SQL khi thực thi.

#### Logic code các generator

```go
package clause

import (
    "fmt"
    "strings"
)

// Định nghĩa kiểu hàm generator
type generator func(values ...interface{}) (string, []interface{})

// Map lưu trữ các generator theo loại mệnh đề
var generators map[Type]generator

// Khởi tạo map và đăng ký các generator
func init() {
    generators = make(map[Type]generator)
    generators[INSERT] = _insert
    generators[VALUES] = _values
    generators[SELECT] = _select
    generators[LIMIT] = _limit
    generators[WHERE] = _where
    generators[ORDERBY] = _orderBy
}

// Tạo chuỗi các dấu ? cho prepared statement
func genBindVars(num int) string {
    var vars []string
    for i := 0; i < num; i++ {
        vars = append(vars, "?")
    }
    return strings.Join(vars, ", ")
}

// Generator cho mệnh đề INSERT
func _insert(values ...interface{}) (string, []interface{}) {
    // INSERT INTO $tableName ($fields)
    tableName := values[0]
    fields := strings.Join(values[1].([]string), ",")
    return fmt.Sprintf("INSERT INTO %s (%v)", tableName, fields), []interface{}{}
}

// Generator cho mệnh đề VALUES
func _values(values ...interface{}) (string, []interface{}) {
    // VALUES ($v1), ($v2), ...
    var bindStr string
    var sql strings.Builder
    var vars []interface{}
    sql.WriteString("VALUES ")
    for i, value := range values {
        v := value.([]interface{})
        if bindStr == "" {
            bindStr = genBindVars(len(v))
        }
        sql.WriteString(fmt.Sprintf("(%v)", bindStr))
        if i+1 != len(values) {
            sql.WriteString(", ")
        }
        vars = append(vars, v...)
    }
    return sql.String(), vars
}

// Generator cho mệnh đề SELECT
func _select(values ...interface{}) (string, []interface{}) {
    // SELECT $fields FROM $tableName
    tableName := values[0]
    fields := strings.Join(values[1].([]string), ",")
    return fmt.Sprintf("SELECT %v FROM %s", fields, tableName), []interface{}{}
}

// Generator cho mệnh đề LIMIT
func _limit(values ...interface{}) (string, []interface{}) {
    // LIMIT $num
    return "LIMIT ?", values
}

// Generator cho mệnh đề WHERE
func _where(values ...interface{}) (string, []interface{}) {
    // WHERE $desc
    desc, vars := values[0], values[1:]
    return fmt.Sprintf("WHERE %s", desc), vars
}

// Generator cho mệnh đề ORDER BY
func _orderBy(values ...interface{}) (string, []interface{}) {
    return fmt.Sprintf("ORDER BY %s", values[0]), []interface{}{}
}
```

#### Ví dụ minh họa cho từng generator

- **INSERT**  
  Gọi: `_insert("User", []string{"name", "age"})`  
  Kết quả:  
  - Chuỗi SQL: `INSERT INTO User (name,age)`
  - Tham số: `[]interface{}{}`

- **VALUES**  
  Gọi: `_values([]interface{}{"Tom", 18}, []interface{}{"Sam", 25})`  
  Kết quả:  
  - Chuỗi SQL: `VALUES (?, ?), (?, ?)`
  - Tham số: `[]interface{}{"Tom", 18, "Sam", 25}`

- **SELECT**  
  Gọi: `_select("User", []string{"name", "age"})`  
  Kết quả:  
  - Chuỗi SQL: `SELECT name,age FROM User`
  - Tham số: `[]interface{}{}`

- **WHERE**  
  Gọi: `_where("age > ?", 18)`  
  Kết quả:  
  - Chuỗi SQL: `WHERE age > ?`
  - Tham số: `[]interface{}{18}`

- **ORDER BY**  
  Gọi: `_orderBy("age DESC")`  
  Kết quả:  
  - Chuỗi SQL: `ORDER BY age DESC`
  - Tham số: `[]interface{}{}`

- **LIMIT**  
  Gọi: `_limit(10)`  
  Kết quả:  
  - Chuỗi SQL: `LIMIT ?`
  - Tham số: `[]interface{}{10}`

> **Gợi ý:** Hãy xem các ví dụ trên để hình dung rõ hơn về đầu vào và đầu ra của từng generator, sau đó hãy quay lại đọc phần code để hiểu cách chúng hoạt động.

Sau khi xây dựng các generator cho từng mệnh đề, bước tiếp theo là thiết kế một cấu trúc để lưu trữ và kết hợp các mệnh đề này lại thành một câu lệnh SQL hoàn chỉnh.

### Cấu trúc Clause - Kết hợp các mệnh đề

Để quản lý việc xây dựng câu lệnh SQL một cách linh hoạt, chúng ta sử dụng một cấu trúc trung gian tên là Clause.
Ý tưởng là mỗi mệnh đề sẽ được xây dựng và lưu trữ riêng biệt. Khi cần, chỉ việc ghép các mệnh đề này lại với nhau theo đúng thứ tự để tạo thành một câu lệnh SQL hoàn chỉnh.

#### Lợi ích khi sử dụng Clause
- **Linh hoạt**:
Bạn có thể dễ dàng thêm, bớt hoặc thay đổi thứ tự các mệnh đề trong câu lệnh SQL mà không cần viết lại toàn bộ câu lệnh.
Ví dụ: Nếu muốn thêm giới hạn số lượng bản ghi trả về, chỉ cần thêm mệnh đề LIMIT:

```go
clause.Set(LIMIT, 10)
sql, vars := clause.Build(SELECT, WHERE, ORDERBY, LIMIT)
```
Nếu không cần giới hạn, chỉ cần bỏ qua mệnh đề LIMIT khi build:
```go
sql, vars := clause.Build(SELECT, WHERE, ORDERBY)
```
- **Tái sử dụng**:
Các mệnh đề đã xây dựng có thể dùng lại ở nhiều nơi khác nhau trong chương trình, giúp tránh lặp lại code.
Ví dụ: Bạn có thể dùng chung mệnh đề WHERE cho nhiều truy vấn khác nhau:
```go
clause.Set(WHERE, "status = ?", "active")
// Dùng cho truy vấn lấy user
clause.Set(SELECT, "User", []string{"name", "age"})
sql1, vars1 := clause.Build(SELECT, WHERE)
// Dùng cho truy vấn lấy order
clause.Set(SELECT, "Order", []string{"id", "amount"})
sql2, vars2 := clause.Build(SELECT, WHERE)
```
- **Dễ đọc, dễ hiểu**:
Việc xây dựng từng mệnh đề riêng biệt và ghép lại giúp câu lệnh SQL rõ ràng, dễ kiểm soát và dễ debug hơn so với việc nối chuỗi thủ công.

#### Định nghĩa cấu trúc Clause và các phương thức Set, Build
```go
package clause

import "strings"

// Cấu trúc Clause lưu trữ các mệnh đề SQL và tham số tương ứng
type Clause struct {
    sql     map[Type]string        // Lưu chuỗi SQL của từng loại mệnh đề
    sqlVars map[Type][]interface{} // Lưu tham số của từng loại mệnh đề
}

// Các loại mệnh đề SQL
type Type int

const (
    INSERT Type = iota
    VALUES
    SELECT
    LIMIT
    WHERE
    ORDERBY
)

// Thêm một mệnh đề vào Clause
func (c *Clause) Set(name Type, vars ...interface{}) {
    // Khởi tạo map nếu chưa có
    if c.sql == nil {
        c.sql = make(map[Type]string)
        c.sqlVars = make(map[Type][]interface{})
    }
    
    // Tạo chuỗi SQL và lấy tham số từ generator
    sql, vars := generators[name](vars...)
    
    // Lưu vào map
    c.sql[name] = sql
    c.sqlVars[name] = vars
}

// Xây dựng câu lệnh SQL hoàn chỉnh theo thứ tự các mệnh đề
func (c *Clause) Build(orders ...Type) (string, []interface{}) {
    var sqls []string
    var vars []interface{}
    
    // Duyệt qua các loại mệnh đề theo thứ tự
    for _, order := range orders {
        if sql, ok := c.sql[order]; ok {
            sqls = append(sqls, sql)
            vars = append(vars, c.sqlVars[order]...)
        }
    }
    
    // Nối các mệnh đề lại với nhau bằng dấu cách
    return strings.Join(sqls, " "), vars
}
```

Cấu trúc `Clause` có hai phương thức chính:
- `Set`: Thêm một mệnh đề vào Clause bằng cách gọi generator tương ứng
- `Build`: Xây dựng câu lệnh SQL hoàn chỉnh theo thứ tự các mệnh đề được chỉ định

### Ví dụ minh họa cách hoạt động

Để hiểu rõ hơn cách hoạt động của `Clause`, hãy xem ví dụ sau:

```go
var clause Clause

// Thêm các mệnh đề
clause.Set(SELECT, "User", []string{"name", "age"})
clause.Set(WHERE, "age > ?", 18)
clause.Set(ORDERBY, "age DESC")
clause.Set(LIMIT, 10)

// Xây dựng câu lệnh SQL theo thứ tự
sql, vars := clause.Build(SELECT, WHERE, ORDERBY, LIMIT)

// Kết quả:
// sql = "SELECT name,age FROM User WHERE age > ? ORDER BY age DESC LIMIT ?"
// vars = []interface{}{18, 10}
```

Như vậy, chúng ta có thể dễ dàng xây dựng các câu lệnh SQL phức tạp bằng cách kết hợp các mệnh đề đơn giản.

### Kiểm thử

Để đảm bảo hệ thống xây dựng câu lệnh SQL hoạt động đúng, chúng ta sẽ viết một test case trong file `clause_test.go`. Test này sẽ kiểm tra xem việc kết hợp các mệnh đề có tạo ra đúng câu lệnh SQL và danh sách tham số hay không.

```go
func testSelect(t *testing.T) {
    var clause Clause
    
    // Thêm các mệnh đề
    clause.Set(LIMIT, 3)
    clause.Set(SELECT, "User", []string{"*"})
    clause.Set(WHERE, "Name = ?", "Tom")
    clause.Set(ORDERBY, "Age ASC")
    
    // Xây dựng câu lệnh SQL
    sql, vars := clause.Build(SELECT, WHERE, ORDERBY, LIMIT)
    t.Log(sql, vars)
    
    // Kiểm tra kết quả
    expectedSQL := "SELECT * FROM User WHERE Name = ? ORDER BY Age ASC LIMIT ?"
    expectedVars := []interface{}{"Tom", 3}
    
    if sql != expectedSQL {
        t.Fatal("failed to build SQL")
    }
    if !reflect.DeepEqual(vars, expectedVars) {
        t.Fatal("failed to build SQLVars")
    }
}

func TestClause_Build(t *testing.T) {
    t.Run("select", func(t *testing.T) {
        testSelect(t)
    })
}
```

Với cách kiểm thử này, bạn có thể chắc chắn rằng hệ thống Clause sẽ tạo ra đúng câu lệnh SQL và danh sách tham số, giúp việc xây dựng các truy vấn phức tạp trở nên linh hoạt và có cấu trúc hơn.

## 2. Triển khai chức năng Insert

Đầu tiên, chúng ta bổ sung một biến thành viên `clause` vào struct `Session`. Như đã rõ ở phần 1, biến này sẽ đóng vai trò tập hợp và quản lý từng mệnh đề riêng lẻ của câu lệnh SQL (ví dụ: INSERT, WHERE, LIMIT,...), giúp việc xây dựng và kết hợp các phần này thành một câu lệnh SQL hoàn chỉnh trở nên dễ dàng và linh hoạt hơn.

```go
// session/raw.go
type Session struct {
    db       *sql.DB
    dialect  dialect.Dialect
    refTable *schema.Schema
    clause   clause.Clause
    sql      strings.Builder
    sqlVars  []interface{}
}

func (s *Session) Clear() {
    s.sql.Reset()
    s.sqlVars = nil
    s.clause = clause.Clause{}
}
```

Với sự hỗ trợ của `clause`, việc tạo các câu lệnh SQL như INSERT hoặc SELECT trở nên đơn giản và linh hoạt hơn.

Câu lệnh SQL để thêm nhiều bản ghi thường có dạng:

```sql
INSERT INTO table_name(col1, col2, col3, ...) VALUES
    (A1, A2, A3, ...),
    (B1, B2, B3, ...),
    ...
```

Trong framework ORM, bạn mong muốn có thể thêm nhiều bản ghi chỉ với một lệnh gọi hàm đơn giản như sau:

```go
s := geeorm.NewEngine("sqlite3", "gee.db").NewSession()
u1 := &User{Name: "Tom", Age: 18}
u2 := &User{Name: "Sam", Age: 25}
s.Insert(u1, u2, ...)
```

Để thực hiện được điều này, ta cần chuyển đổi từng đối tượng Go (ví dụ: u1, u2) thành một danh sách giá trị tương ứng với các cột trong bảng.
Ví dụ, hai đối tượng trên sẽ được chuyển thành:
- u1 → ("Tom", 18)
- u2 → ("Sam", 25)

Để hỗ trợ việc này, ta thêm hàm RecordValues vào struct Schema:

```go
// day3-save-query/schema/schema.go

// RecordValues nhận vào một struct (dest) và trả về slice các giá trị của các trường (fields) trong struct đó,
// theo đúng thứ tự định nghĩa trong schema.Fields.
// Hàm này dùng để chuyển một đối tượng Go thành danh sách giá trị để chèn vào câu lệnh SQL.
func (schema *Schema) RecordValues(dest interface{}) []interface{} {
    // Lấy giá trị thực của dest, loại bỏ lớp con trỏ nếu có
    destValue := reflect.Indirect(reflect.ValueOf(dest))
    var fieldValues []interface{}
    // Duyệt qua từng trường đã định nghĩa trong schema.Fields
    for _, field := range schema.Fields {
        // Lấy giá trị của trường theo tên và thêm vào slice fieldValues
        fieldValues = append(fieldValues, destValue.FieldByName(field.Name).Interface())
    }
    // Trả về danh sách giá trị của các trường
    return fieldValues
}
```
#### Ví dụ:
Giả sử bạn có struct sau:
```go
type User struct {
    Name string
    Age  int
}
u := &User{Name: "Tom", Age: 18}
```
Khi gọi schema.RecordValues(u), kết quả trả về sẽ là: []interface{}{"Tom", 18}

Sau khi đã có hàm chuyển đổi giá trị, ta triển khai hàm Insert trong session như sau:

```go
// day3-save-query/session/record.go
package session

import (
    "geeorm/clause"
    "reflect"
)

// Insert nhận vào một hoặc nhiều đối tượng (values), chuyển chúng thành các bản ghi và thêm vào cơ sở dữ liệu.
// Trả về số bản ghi được thêm thành công và lỗi (nếu có).
func (s *Session) Insert(values ...interface{}) (int64, error) {
    recordValues := make([]interface{}, 0)
    for _, value := range values {
         // Lấy thông tin bảng (schema) từ đối tượng value
        table := s.Model(value).RefTable()
        // Thiết lập mệnh đề INSERT với tên bảng và danh sách tên các trường
        s.clause.Set(clause.INSERT, table.Name, table.FieldNames)
        // Lấy giá trị của từng trường trong đối tượng value và gom vào recordValues
        recordValues = append(recordValues, table.RecordValues(value))
    }

    // Thiết lập mệnh đề VALUES với tất cả giá trị của các bản ghi cần thêm
    s.clause.Set(clause.VALUES, recordValues...)
    // Xây dựng câu lệnh SQL hoàn chỉnh từ các mệnh đề đã thiết lập
    sql, vars := s.clause.Build(clause.INSERT, clause.VALUES)
    // Thực thi câu lệnh SQL với các tham số vars
    result, err := s.Raw(sql, vars...).Exec()
    if err != nil {
        return 0, err
    }

    // Trả về số bản ghi đã thêm thành công
    return result.RowsAffected()
}
```

Khi thực hiện Insert, bạn sẽ làm theo hai bước chính:

- Gọi nhiều lần clause.Set() để xây dựng từng mệnh đề (INSERT, VALUES, ...).
- Gọi một lần clause.Build() để kết hợp các mệnh đề này thành một câu lệnh SQL hoàn chỉnh.

Sau đó, bạn chỉ cần gọi Raw().Exec() để thực thi câu lệnh SQL vừa xây dựng.

Nhờ việc tách riêng từng mệnh đề và sử dụng cấu trúc Clause, việc xây dựng và thực thi các câu lệnh INSERT trở nên rõ ràng, linh hoạt và dễ mở rộng hơn rất nhiều.

## 3. Triển khai chức năng Find

Chức năng Find cho phép bạn truy vấn nhiều bản ghi từ cơ sở dữ liệu và lưu kết quả vào một slice. Cách sử dụng mong đợi là truyền vào một con trỏ tới slice, sau khi truy vấn xong, slice này sẽ chứa toàn bộ kết quả.

#### Ví dụ sử dụng:

```go
s := geeorm.NewEngine("sqlite3", "gee.db").NewSession()
var users []User
s.Find(&users)
fmt.Println(users) // [{Tom 18} {Sam 25} ...]
```

### Giải thích ý tưởng
Nếu như hàm Insert cần "trải rộng" các giá trị trường của một struct để chèn vào cơ sở dữ liệu, thì hàm Find lại làm điều ngược lại:

- Lấy từng dòng dữ liệu từ cơ sở dữ liệu,
- Xây dựng lại từng struct từ các giá trị trường đã trải rộng đó,
- Thêm từng struct vào slice kết quả.

Để làm được điều này một cách linh hoạt với mọi kiểu struct, ta cần sử dụng reflection.

### Implement hàm Find
```go
func (s *Session) Find(values interface{}) error {
    // Lấy giá trị thực của con trỏ slice truyền vào (ví dụ: *[]User -> []User)
    destSlice := reflect.Indirect(reflect.ValueOf(values))
    // Lấy kiểu của phần tử trong slice (ví dụ: User)
    destType := destSlice.Type().Elem()
    // Tạo một struct mẫu để lấy thông tin bảng (schema)
    table := s.Model(reflect.New(destType).Elem().Interface()).RefTable()

    // Xây dựng câu lệnh SELECT dựa trên schema
    s.clause.Set(clause.SELECT, table.Name, table.FieldNames)
    sql, vars := s.clause.Build(clause.SELECT, clause.WHERE, clause.ORDERBY, clause.LIMIT)
    rows, err := s.Raw(sql, vars...).QueryRows()
    if err != nil {
        return err
    }

    // Duyệt qua từng dòng kết quả trả về từ cơ sở dữ liệu
    for rows.Next() {
        // Tạo một struct mới kiểu destType (ví dụ: User)
        dest := reflect.New(destType).Elem()
        var values []interface{}
        // Chuẩn bị các địa chỉ trường để Scan dữ liệu vào
        for _, name := range table.FieldNames {
            values = append(values, dest.FieldByName(name).Addr().Interface())
        }
        // Đọc dữ liệu từ hàng hiện tại vào các trường của struct
        if err := rows.Scan(values...); err != nil {
            return err
        }
        // Thêm struct vừa tạo vào slice kết quả
        destSlice.Set(reflect.Append(destSlice, dest))
    }
    return rows.Close()
}
```

Việc triển khai Find tương đối phức tạp và chủ yếu được chia thành các bước sau:

1) **Lấy thông tin về slice và kiểu phần tử:**
- Sử dụng reflection để lấy ra slice thực sự và kiểu phần tử bên trong slice (ví dụ: User).
- Tạo một struct mẫu để lấy thông tin schema (tên bảng, tên trường).
2) **Xây dựng câu lệnh SELECT:** Sử dụng các mệnh đề đã xây dựng (clause) để tạo câu lệnh SELECT phù hợp với bảng và các trường cần lấy.
3) **Duyệt qua từng dòng kết quả:**
- Với mỗi dòng dữ liệu trả về từ cơ sở dữ liệu, tạo một struct mới kiểu User.
- Chuẩn bị một slice các địa chỉ trường của struct để truyền vào hàm Scan.
4) **Gán dữ liệu vào struct:** Sử dụng rows.Scan(values...) để gán giá trị từng cột vào đúng trường tương ứng của struct.
5) **Thêm struct vào slice kết quả:** Dùng reflection để append struct vừa tạo vào slice kết quả.

#### Ví dụ minh họa
Giả sử bảng User trong cơ sở dữ liệu có hai dòng:

| name  | age |
| ----- | --- |
| Tom   | 18  |
| Sam   | 25  |

Sau khi gọi:
```go
var users []User
s.Find(&users)
```

Kết quả biến users sẽ là:
```go
[]User{
    {Name: "Tom", Age: 18},
    {Name: "Sam", Age: 25},
}
```
Như vậy, hàm Find giúp bạn dễ dàng truy vấn nhiều bản ghi và ánh xạ kết quả về slice các struct một cách tự động, linh hoạt cho mọi kiểu dữ liệu.
## 4. Kiểm thử

Để đảm bảo các chức năng thêm và truy vấn dữ liệu hoạt động đúng, chúng ta sẽ viết các test case trong file `record_test.go` của thư mục session.

Lưu ý: Định nghĩa struct User và hàm `NewSession()` đã có sẵn trong file `raw_test.go.`

```go
// day3-save-query/session/record_test.go
package session

import "testing"

// Khởi tạo một số dữ liệu mẫu để phục vụ kiểm thử
var (
    user1 = &User{"Tom", 18}
    user2 = &User{"Sam", 25}
    user3 = &User{"Jack", 25}
)

// Hàm hỗ trợ khởi tạo dữ liệu test: xóa bảng, tạo bảng mới và thêm 2 bản ghi mẫu
func testRecordInit(t *testing.T) *Session {
    t.Helper()
    s := NewSession().Model(&User{})
    err1 := s.DropTable()
    err2 := s.CreateTable()
    _, err3 := s.Insert(user1, user2)
    if err1 != nil || err2 != nil || err3 != nil {
        t.Fatal("failed init test records")
    }
    return s
}

// Kiểm thử chức năng Insert: thêm một bản ghi mới vào bảng
func TestSession_Insert(t *testing.T) {
    s := testRecordInit(t)
    affected, err := s.Insert(user3)
    if err != nil || affected != 1 {
        t.Fatal("failed to create record")
    }
}

// Kiểm thử chức năng Find: truy vấn tất cả bản ghi trong bảng
func TestSession_Find(t *testing.T) {
    s := testRecordInit(t)
    var users []User
    if err := s.Find(&users); err != nil || len(users) != 2 {
        t.Fatal("failed to query all")
    }
}
```
Ở đây, chúng ta kiểm tra hai chức năng chính:

- Insert: Đảm bảo có thể thêm một bản ghi mới vào bảng.
- Find: Đảm bảo có thể truy vấn và lấy đúng số lượng bản ghi đã thêm vào.

## 5. Kết luận
Qua bài viết này, bạn đã học được cách xây dựng một hệ thống ORM đơn giản với Go, bao gồm:

- Tách riêng từng mệnh đề SQL (clause) và xây dựng các generator cho từng loại mệnh đề.
- Thiết kế cấu trúc Clause để quản lý và kết hợp các mệnh đề thành câu lệnh SQL hoàn chỉnh.
- Triển khai các chức năng thao tác dữ liệu như Insert và Find một cách linh hoạt, dễ mở rộng.
- Viết test case để kiểm tra tính đúng đắn của các chức năng.

Hy vọng sau khi thực hành, bạn đã hiểu rõ hơn về cách hoạt động của ORM, cũng như cách tổ chức code để xây dựng các hệ thống linh hoạt, dễ bảo trì.

Ở phần tiếp theo của chuỗi bài viết, chúng ta sẽ tiếp tục mở rộng framework GeeORM với các tính năng nâng cao hơn, bao gồm:
- Hỗ trợ thao tác chuỗi (chain operation), cho phép kết hợp nhiều điều kiện truy vấn như where, order by, limit,... một cách linh hoạt.
- Triển khai các chức năng cập nhật (update), xóa (delete) và đếm số lượng bản ghi (count)