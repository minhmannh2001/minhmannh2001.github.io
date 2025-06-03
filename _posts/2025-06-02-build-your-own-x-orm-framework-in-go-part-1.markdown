---
layout: post
title: 'Build your own X: Tự xây dựng một ORM framework với Go - Phần 1: Cơ bản về Database/SQL'
date: '2025-06-02 14:30'
excerpt: >-
  Phần 1 trong chuỗi bài về xây dựng ORM framework với Go. Bài viết này tập trung vào việc tìm hiểu cơ bản về SQLite, sử dụng thư viện database/sql của Go và xây dựng cấu trúc cơ bản cho framework ORM.
comments: false
---

# Phần 1: Cơ bản về Database/SQL trong GeeORM

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết đầu tiên trong loạt bài hướng dẫn xây dựng ORM framework GeeORM từ đầu bằng Go trong 7 ngày.

## Mục tiêu của bài viết này

- Tìm hiểu các thao tác cơ bản với SQLite (kết nối đến cơ sở dữ liệu, tạo bảng, thêm và xóa bản ghi, v.v.)
- Sử dụng thư viện chuẩn database/sql của Go để kết nối và thao tác với cơ sở dữ liệu SQLite
- Xây dựng cấu trúc cơ bản cho framework ORM

## 1. Giới thiệu về SQLite

> SQLite là một thư viện viết bằng C, triển khai một cơ sở dữ liệu SQL nhỏ gọn, nhanh, độc lập, đáng tin cậy và đầy đủ tính năng.
> – Trang web chính thức của SQLite

### Đặc điểm của SQLite

SQLite là một hệ quản trị cơ sở dữ liệu quan hệ nhỏ gọn, tuân thủ đầy đủ các nguyên tắc ACID (Atomicity, Consistency, Isolation, Durability). Điểm khác biệt chính so với MySQL và PostgreSQL là SQLite không hoạt động theo mô hình client/server - thay vào đó, nó được tích hợp trực tiếp vào ứng dụng của bạn. Toàn bộ cơ sở dữ liệu được lưu trữ trong một tệp duy nhất, giúp việc triển khai và quản lý trở nên đơn giản.

Với đặc tính nhẹ nhàng và dễ sử dụng, SQLite là lựa chọn lý tưởng cho người mới bắt đầu học về cơ sở dữ liệu quan hệ. Đây cũng là lý do chúng ta chọn SQLite làm nền tảng cho toàn bộ quá trình phát triển và kiểm thử GeeORM.

### Cài đặt và sử dụng cơ bản

Trên Ubuntu, việc cài đặt SQLite chỉ cần một dòng lệnh đơn giản:

```bash
apt-get install sqlite3
```

Sau khi cài đặt, bạn có thể kết nối đến một cơ sở dữ liệu bằng lệnh `sqlite3` theo sau là tên tệp cơ sở dữ liệu. Nếu tệp không tồn tại, SQLite sẽ tự động tạo mới:

```bash
> sqlite3 gee.db
SQLite version 3.22.0 2018-01-22 18:45:57
Enter ".help" for usage hints.
sqlite>
```

### Các thao tác cơ bản với SQLite

Bây giờ chúng ta sẽ thực hiện một số thao tác cơ bản với SQLite để làm quen với cú pháp của nó:

1. **Tạo bảng mới**: Tạo bảng `User` với hai trường - `Name` (kiểu text) và `Age` (kiểu integer)

```sql
sqlite> CREATE TABLE User(Name text, Age integer);
```

2. **Thêm dữ liệu**: Chèn hai bản ghi vào bảng `User`

```sql
sqlite> INSERT INTO User(Name, Age) VALUES ("Tom", 18), ("Jack", 25);
```

3. **Truy vấn dữ liệu**: Để hiển thị kết quả truy vấn rõ ràng hơn, trước tiên bật hiển thị tên cột

```sql
sqlite> .head on

# Tìm người dùng có tuổi lớn hơn 20
sqlite> SELECT * FROM User WHERE Age > 20;
Name|Age
Jack|25

# Đếm tổng số bản ghi
sqlite> SELECT COUNT(*) FROM User;
COUNT(*)
2
```

4. **Xem thông tin cấu trúc**: SQLite cung cấp các lệnh đặc biệt để xem thông tin về cơ sở dữ liệu

```sql
# Liệt kê tất cả các bảng
sqlite> .table
User

# Xem cấu trúc của bảng User
sqlite> .schema User
CREATE TABLE User(Name text, Age integer);
```

Những thao tác cơ bản trên đã cung cấp cho chúng ta nền tảng đủ để bắt đầu xây dựng framework ORM. Nếu bạn muốn tìm hiểu thêm về SQLite, hãy tham khảo [Các lệnh thông dụng của SQLite](https://www.sqlite.org/cli.html).

## 2. Thư viện chuẩn database/sql

Go cung cấp thư viện chuẩn `database/sql` để tương tác với cơ sở dữ liệu. Hãy xem một ví dụ đơn giản để hiểu cách sử dụng thư viện này:

```go
package main

import (
    "database/sql"
    "log"
    _ "github.com/mattn/go-sqlite3"
)

func main() {
    // Kết nối đến cơ sở dữ liệu SQLite
    db, _ := sql.Open("sqlite3", "gee.db")
    defer func() { _ = db.Close() }()
    
    // Tạo bảng mới
    _, _ = db.Exec("DROP TABLE IF EXISTS User;")
    _, _ = db.Exec("CREATE TABLE User(Name text);")
    
    // Chèn dữ liệu và kiểm tra số bản ghi bị ảnh hưởng
    result, err := db.Exec("INSERT INTO User(`Name`) values (?), (?)", "Tom", "Sam")
    if err == nil {
        affected, _ := result.RowsAffected()
        log.Println(affected)
    }
    
    // Truy vấn một bản ghi
    row := db.QueryRow("SELECT Name FROM User LIMIT 1")
    var name string
    if err := row.Scan(&name); err == nil {
        log.Println(name)
    }
}
```

Lưu ý: Driver go-sqlite3 phụ thuộc vào gcc. Nếu bạn đang sử dụng Windows, bạn cần cài đặt mingw hoặc một bộ công cụ tương tự có chứa trình biên dịch gcc.

Khi thực thi `go run .`, bạn sẽ thấy kết quả như sau:

```
> go run .
2025/06/02 20:28:37 2
2025/06/02 20:28:37 Tom
```

Phân tích các thành phần chính trong ví dụ:

1. **Kết nối cơ sở dữ liệu**: Hàm `sql.Open()` cần hai thông tin: loại cơ sở dữ liệu (sqlite3) và tên tệp cơ sở dữ liệu (gee.db). Dòng `import _ "github.com/mattn/go-sqlite3"` giúp Go biết cách kết nối với SQLite. Nếu tệp gee.db chưa tồn tại, SQLite sẽ tự tạo mới.

2. **Thực thi câu lệnh SQL**: Phương thức `Exec()` dùng để thực thi các câu lệnh không trả về dữ liệu như CREATE, INSERT, UPDATE, DELETE. Nó trả về một đối tượng `sql.Result` cho phép kiểm tra số bản ghi bị ảnh hưởng.

3. **Truy vấn dữ liệu**: 
   - `QueryRow()` dùng khi bạn cần truy vấn một bản ghi duy nhất
   - `Query()` dùng khi cần truy vấn nhiều bản ghi

4. **Tham số hóa truy vấn**: Các phương thức `Exec()`, `Query()`, `QueryRow()` đều hỗ trợ tham số hóa với placeholder `?`, giúp ngăn chặn SQL injection. Các giá trị thực tế được truyền vào sau câu lệnh SQL.

5. **Đọc kết quả truy vấn**: Phương thức `Scan()` của `*sql.Row` cho phép đọc giá trị của các cột vào các biến Go tương ứng thông qua con trỏ.

Sau khi hiểu rõ cách sử dụng thư viện chuẩn `database/sql`, chúng ta đã có nền tảng cần thiết để bắt đầu xây dựng framework ORM của riêng mình.

## 3. Triển khai một thư viện log đơn giản

Khi phát triển framework, việc có hệ thống log tốt giúp chúng ta dễ dàng phát hiện và sửa lỗi. Trước khi bắt đầu viết mã lõi của GeeORM, chúng ta sẽ tạo một thư viện log đơn giản nhưng hiệu quả.

Thư viện log chuẩn của Go có một số hạn chế: không phân loại log theo mức độ nghiêm trọng và không tự động hiển thị tên file/số dòng gây lỗi. Thư viện log của chúng ta sẽ khắc phục những hạn chế này với các tính năng:

- Phân loại log thành ba cấp độ: Info, Error và Disabled
- Hiển thị log với màu sắc khác nhau để dễ phân biệt
- Tự động hiển thị tên file và số dòng phát sinh log

Đầu tiên, tạo module cho dự án:

```bash
go mod init geeorm
```

Sau đó tạo file `log/log.go` với cấu trúc thư mục như sau:

```
day1-database-sql/
    |-- log/
        |--log.go
    |--go.mod
```

Trong file `log.go`, chúng ta tạo hai logger riêng biệt cho thông tin và lỗi:

```go
package log

import (
    "io/ioutil"
    "log"
    "os"
    "sync"
)

var (
    errorLog = log.New(os.Stdout, "\033[31m[error]\033[0m ", log.LstdFlags|log.Lshortfile)
    infoLog = log.New(os.Stdout, "\033[34m[info ]\033[0m ", log.LstdFlags|log.Lshortfile)
    loggers = []*log.Logger{errorLog, infoLog}
    mu sync.Mutex
)

// log methods
var (
    Error = errorLog.Println
    Errorf = errorLog.Printf
    Info = infoLog.Println
    Infof = infoLog.Printf
)
```

Trong đoạn mã trên:
- `[info ]` được hiển thị màu xanh dương và `[error]` màu đỏ nhờ mã ANSI
- Flag `log.Lshortfile` tự động thêm tên file và số dòng vào mỗi log
- Chúng ta export 4 hàm log để sử dụng: `Error`, `Errorf`, `Info`, `Infof`

Tiếp theo, chúng ta thêm khả năng điều chỉnh cấp độ log:

```go
// log levels
const (
    InfoLevel = iota
    ErrorLevel
    Disabled
)

// SetLevel controls log level
func SetLevel(level int) {
    mu.Lock()
    defer mu.Unlock()

    for _, logger := range loggers {
        logger.SetOutput(os.Stdout)
    }

    if ErrorLevel < level {
        errorLog.SetOutput(ioutil.Discard)
    }
    if InfoLevel < level {
        infoLog.SetOutput(ioutil.Discard)
    }
}
```

Hệ thống cấp độ log hoạt động như sau:
- Ba cấp độ được định nghĩa theo thứ tự tăng dần: InfoLevel (0), ErrorLevel (1), và Disabled (2)
- Khi đặt cấp độ là ErrorLevel, chỉ các thông báo lỗi được hiển thị, còn thông tin thông thường bị ẩn
- Khi đặt cấp độ là Disabled, không có log nào được hiển thị

Cơ chế này hoạt động bằng cách chuyển hướng đầu ra của logger đến `ioutil.Discard`, một đối tượng đặc biệt trong Go sẽ bỏ qua tất cả dữ liệu được ghi vào nó. Điều này cho phép chúng ta kiểm soát chính xác những thông tin nào được hiển thị trong quá trình phát triển và vận hành framework.

## 4. Session - Lớp tương tác với cơ sở dữ liệu

Chúng ta sẽ tạo một thư mục mới `session` trong thư mục gốc để chứa code liên quan đến tương tác với cơ sở dữ liệu. Trong phần này, chúng ta sẽ tập trung vào việc triển khai các phương thức cơ bản để thực thi câu lệnh SQL. Code này được đặt trong file `session/raw.go`.

```go
package session

import (
    "database/sql"
    "geeorm/log"
    "strings"
)

type Session struct {
    db      *sql.DB
    sql     strings.Builder
    sqlVars []interface{}
}

func New(db *sql.DB) *Session {
    return &Session{db: db}
}

func (s *Session) Clear() {
    s.sql.Reset()
    s.sqlVars = nil
}

func (s *Session) DB() *sql.DB {
    return s.db
}

func (s *Session) Raw(sql string, values ...interface{}) *Session {
    s.sql.WriteString(sql)
    s.sql.WriteString(" ")
    s.sqlVars = append(s.sqlVars, values...)
    return s
}
```

Cấu trúc `Session` có ba thành phần chính:
- `db *sql.DB`: Kết nối đến cơ sở dữ liệu, được tạo bởi `sql.Open()`
- `sql strings.Builder`: Dùng để xây dựng câu lệnh SQL
- `sqlVars []interface{}`: Lưu trữ các tham số cho câu lệnh SQL

Phương thức `Raw()` cho phép người dùng viết câu lệnh SQL với các tham số, tương tự như cách sử dụng `db.Exec()` hoặc `db.Query()`. Phương thức này trả về chính đối tượng Session, cho phép gọi theo chuỗi (method chaining). Ví dụ, thay vì viết:

```go
session.Raw("SELECT * FROM users WHERE age > ?", 18)
rows, err := session.QueryRows()
```

Chúng ta có thể viết gọn hơn:

```go
rows, err := session.Raw("SELECT * FROM users WHERE age > ?", 18).QueryRows()
```

Tiếp theo, chúng ta đóng gói ba phương thức cơ bản của `database/sql`:

```go
// Exec thực thi câu lệnh SQL với các tham số
func (s *Session) Exec() (result sql.Result, err error) {
    defer s.Clear()
    log.Info(s.sql.String(), s.sqlVars)
    if result, err = s.DB().Exec(s.sql.String(), s.sqlVars...); err != nil {
        log.Error(err)
    }
    return
}

// QueryRow trả về một bản ghi từ cơ sở dữ liệu
func (s *Session) QueryRow() *sql.Row {
    defer s.Clear()
    log.Info(s.sql.String(), s.sqlVars)
    return s.DB().QueryRow(s.sql.String(), s.sqlVars...)
}

// QueryRows trả về nhiều bản ghi từ cơ sở dữ liệu
func (s *Session) QueryRows() (rows *sql.Rows, err error) {
    defer s.Clear()
    log.Info(s.sql.String(), s.sqlVars)
    if rows, err = s.DB().Query(s.sql.String(), s.sqlVars...); err != nil {
        log.Error(err)
    }
    return
}
```

Việc đóng gói các phương thức này mang lại hai lợi ích chính:

1. **Ghi log tự động**: Mỗi câu lệnh SQL và các tham số của nó đều được ghi lại trước khi thực thi, giúp dễ dàng theo dõi và debug.

2. **Tự động làm sạch**: Sau khi thực thi xong, phương thức `Clear()` được gọi để xóa câu lệnh SQL và các tham số, chuẩn bị Session cho lần sử dụng tiếp theo. Điều này cho phép tái sử dụng một đối tượng Session cho nhiều câu lệnh SQL khác nhau.

Với thiết kế này, người dùng có thể dễ dàng thực thi các câu lệnh SQL theo cách rõ ràng và linh hoạt:

```go
session.Raw("DROP TABLE IF EXISTS User;").Exec()
session.Raw("CREATE TABLE User(Name text);").Exec()
session.Raw("INSERT INTO User(`Name`) values (?), (?)", "Tom", "Sam").Exec()
```

## 5. Engine - Lớp giao tiếp chính của framework

Trong khi `Session` chịu trách nhiệm thực hiện các thao tác trực tiếp với cơ sở dữ liệu, `Engine` đảm nhận vai trò quản lý kết nối và cung cấp giao diện cho người dùng. `Engine` xử lý các công việc như thiết lập kết nối ban đầu, kiểm tra tình trạng kết nối và đóng kết nối khi cần thiết. Mã nguồn của `Engine` được đặt trong file `geeorm.go` ở thư mục gốc.

```go
package geeorm

import (
    "database/sql"
    "geeorm/log"
    "geeorm/session"
)

type Engine struct {
    db *sql.DB
}

func NewEngine(driver, source string) (e *Engine, err error) {
    db, err := sql.Open(driver, source)
    if err != nil {
        log.Error(err)
        return
    }
    // Gửi một ping để đảm bảo kết nối cơ sở dữ liệu còn sống.
    if err = db.Ping(); err != nil {
        log.Error(err)
        return
    }
    e = &Engine{db: db}
    log.Info("Connect database success")
    return
}

func (engine *Engine) Close() {
    if err := engine.db.Close(); err != nil {
        log.Error("Failed to close database")
    }
    log.Info("Close database success")
}

func (engine *Engine) NewSession() *session.Session {
    return session.New(engine.db)
}
```

Cấu trúc của `Engine` khá đơn giản, với phương thức chính là `NewEngine`. Phương thức này thực hiện hai nhiệm vụ quan trọng:

1. Thiết lập kết nối đến cơ sở dữ liệu thông qua `sql.Open()`
2. Kiểm tra kết nối bằng cách gọi `db.Ping()` để đảm bảo cơ sở dữ liệu hoạt động bình thường

`Engine` cũng cung cấp phương thức `NewSession()` để tạo ra các đối tượng `Session` mới, cho phép người dùng thực hiện các thao tác với cơ sở dữ liệu. Với cấu trúc này, người dùng chỉ cần tương tác với `Engine` để sử dụng toàn bộ chức năng của framework.

Đến đây, cấu trúc cơ bản của GeeORM đã hoàn thành:

```
day1-database-sql/
    |-- log/           # Hệ thống log
         |--log.go
    |--session/       # Tương tác cơ sở dữ liệu
         |--raw.go
    |--geeorm.go      # Lớp giao tiếp chính
     |--go.mod
```

## 6. Thử nghiệm framework

GeeORM có bộ unit test khá đầy đủ. Bạn có thể tham khảo các file như `log_test.go`, `raw_test.go` và `geeorm_test.go`. Chúng ta sẽ không đi sâu vào từng file test ở đây. Thay vào đó, hãy xem cách sử dụng GeeORM trong một ứng dụng thực tế.

Tạo một thư mục `cmd_test` trong thư mục gốc và thêm file `main.go` với nội dung sau:

```go
package main

import (
    "fmt"
    "geeorm"
    "geeorm/log"
    _ "github.com/mattn/go-sqlite3"
)

func main() {
    engine, _ := geeorm.NewEngine("sqlite3", "gee.db")
    defer engine.Close()
    
    s := engine.NewSession()
    _, _ = s.Raw("DROP TABLE IF EXISTS User;").Exec()
    _, _ = s.Raw("CREATE TABLE User(Name text);").Exec()
    _, _ = s.Raw("CREATE TABLE User(Name text);").Exec()
    
    result, _ := s.Raw("INSERT INTO User(`Name`) values (?), (?)", "Tom", "Sam").Exec()
    count, _ := result.RowsAffected()
    fmt.Printf("Exec success, %d affected\n", count)
}
```

Khi chạy `go run main.go`, bạn sẽ thấy kết quả như sau:

![geeorm log](/img/gee-orm/part-2/geeorm-log.png)

Trong log xuất hiện thông báo lỗi `table User already exists` vì chúng ta đã cố gắng tạo bảng `User` hai lần liên tiếp. Bạn có thể thấy mỗi dòng log đều hiển thị tên file và số dòng phát sinh log, cùng với màu sắc khác nhau cho các cấp độ log khác nhau.

## Kết luận

Trong phần đầu tiên này, chúng ta đã:

1. Tìm hiểu các thao tác cơ bản với SQLite
2. Sử dụng thư viện chuẩn `database/sql` của Go để tương tác với cơ sở dữ liệu
3. Xây dựng một thư viện log đơn giản
4. Triển khai cấu trúc Session để tương tác với cơ sở dữ liệu
5. Triển khai cấu trúc Engine làm điểm giao tiếp chính của framework

Đây là nền tảng cho các phần tiếp theo, nơi chúng ta sẽ xây dựng các tính năng ORM thực sự như ánh xạ đối tượng, truy vấn, cập nhật và xóa bản ghi.
















