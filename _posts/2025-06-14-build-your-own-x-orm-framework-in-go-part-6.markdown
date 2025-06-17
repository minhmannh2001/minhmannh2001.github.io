---
layout: post
title: "Build your own X: Xây dựng ORM framework với Go - Phần 6"
date: '2025-06-14 08:00:00 +0700'
excerpt: >
  Phần 6 trong chuỗi bài về xây dựng ORM framework với Go. Trong bài này, ta sẽ tìm hiểu về transaction trong database, tính chất ACID, cách sử dụng trong Go, và cách tích hợp vào GeeORM để đảm bảo các thao tác an toàn và có thể rollback.
comments: false
---

# Phần 6: Hỗ trợ Transaction trong ORM Framework GeeORM

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ sáu trong loạt hướng dẫn tự xây dựng ORM framework GeeORM với Go trong 7 ngày.

Ở phần này, chúng ta sẽ tìm hiểu về transaction (giao dịch) trong database và cách hỗ trợ nó trong ORM Framework GeeORM.

## 1. Tính chất ACID của Transaction

Transaction trong database là một chuỗi các thao tác truy cập và thay đổi dữ liệu trong cơ sở dữ liệu. Các thao tác này phải được thực hiện theo nguyên tắc **tất cả hoặc không có gì**. Nói cách khác, nếu một giao dịch bao gồm nhiều thao tác, thì tất cả các thao tác đó phải được thực hiện thành công, hoặc không có thao tác nào được thực hiện.

Ví dụ thực tế: 

Chuyển khoản. 
Khi A chuyển 10,000 VNĐ cho B, database cần thực hiện 2 bước:

- Bước 1: Giảm 10,000 VNĐ từ tài khoản của A.
- Bước 2: Tăng 10,000 VNĐ vào tài khoản của B.

Kết quả:
- Nếu cả 2 bước thành công, chuyển khoản thành công.
- Nếu 1 trong 2 bước thất bại, bước trước đó phải được hoàn tác (rollback), chuyển khoản thất bại.
- Không thể chấp nhận được tình huống một bước thành công, bước còn lại thất bại.

Đây là một ví dụ điển hình về việc sử dụng giao dịch (transaction) trong cơ sở dữ liệu.

Nếu một database hỗ trợ transaction, nó phải có 4 tính chất ACID:

1.  **Atomicity (Tính nguyên tử):** Tất cả các thao tác trong một transaction là không thể chia cắt. Hoặc tất cả được thực hiện, hoặc không có thao tác nào được thực hiện.
2.  **Consistency (Tính nhất quán):** Kết quả của việc thực hiện đồng thời nhiều transaction phải giống với kết quả của việc thực hiện tuần tự các transaction theo một thứ tự nhất định.
3.  **Isolation (Tính cô lập):** Việc thực hiện một transaction không bị ảnh hưởng bởi các transaction khác. Kết quả trung gian của transaction phải "trong suốt" với các transaction khác.
4.  **Durability (Tính bền vững):** Với bất kỳ transaction nào đã được commit (hoàn thành), hệ thống phải đảm bảo rằng các thay đổi được thực hiện đối với database sẽ không bị mất, ngay cả khi database gặp sự cố.

## 2. Hiểu về Transaction trong SQLite và cách Go hỗ trợ thông qua `database/sql`

Câu lệnh SQL để tạo một transaction trong SQLite trông như thế nào?

```sql
sqlite> BEGIN;
sqlite> DELETE FROM User WHERE Age > 25;
sqlite> INSERT INTO User VALUES ("Tom", 25), ("Jack", 18);
sqlite> COMMIT;
```

`BEGIN` để bắt đầu transaction, `COMMIT` để commit transaction, và `ROLLBACK` để rollback transaction. Một transaction bắt đầu với `BEGIN` và kết thúc với `COMMIT` hoặc `ROLLBACK`.

Thư viện chuẩn `database/sql` của Go cung cấp interface để hỗ trợ transaction. Hãy xem một ví dụ đơn giản:

```go
package main

import (
	"database/sql"
	_ "github.com/mattn/go-sqlite3"
	"log"
)

func main() {
	db, _ := sql.Open("sqlite3", "gee.db")
	defer func() { _ = db.Close() }()
	_, _ = db.Exec("CREATE TABLE IF NOT EXISTS User(\`Name\` text);")

	tx, _ := db.Begin()
	_, err1 := tx.Exec("INSERT INTO User(\`Name\`) VALUES (?)", "Tom")
	_, err2 := tx.Exec("INSERT INTO User(\`Name\`) VALUES (?)", "Jack")
	if err1 != nil || err2 != nil {
		_ = tx.Rollback()
		log.Println("Rollback", err1, err2)
	} else {
		_ = tx.Commit()
		log.Println("Commit")
	}
}
```

Việc thực hiện transaction trong Go rất giống với các câu lệnh SQL. Gọi `db.Begin()` để lấy một đối tượng `*sql.Tx`, sử dụng `tx.Exec()` để thực hiện các thao tác. Nếu có lỗi xảy ra, gọi `tx.Rollback()` để rollback. Nếu không có lỗi, gọi `tx.Commit()` để commit.

## 3. GeeORM hỗ trợ Transaction

Trước đây, mọi thao tác trong GeeORM đều được thực hiện một cách độc lập và sẽ tự động commit sau khi thực hiện xong. Ta sử dụng `sql.DB` để chạy các lệnh SQL. Tuy nhiên, để hỗ trợ transaction (giao dịch), ta cần thay đổi sang sử dụng `sql.Tx`.

Giải pháp là:

- Thêm một biến `tx *sql.Tx` vào trong struct Session.
- Khi `tx` khác nil, ta sử dụng `tx` để thực hiện truy vấn SQL.
- Ngược lại, nếu `tx` là nil, ta dùng `db` như trước kia.

Điều này giúp ta vừa giữ được cách thực thi cũ, vừa hỗ trợ thêm transaction mà không phá vỡ thiết kế cũ.

`part-6-transaction/session/raw.go`

```go
type Session struct {
	db       *sql.DB
	dialect  dialect.Dialect
	tx       *sql.Tx
	refTable *schema.Schema
	clause   clause.Clause
	sql      strings.Builder
	sqlVars  []interface{}
}

// Interface chung giữa *sql.DB và *sql.Tx để dùng chung trong Session
type CommonDB interface {
	Query(query string, args ...interface{}) (*sql.Rows, error)
	QueryRow(query string, args ...interface{}) *sql.Row
	Exec(query string, args ...interface{}) (sql.Result, error)
}

// Đảm bảo rằng *sql.DB và *sql.Tx đều thoả mãn interface CommonDB
var _ CommonDB = (*sql.DB)(nil)
var _ CommonDB = (*sql.Tx)(nil)

// Hàm DB trả về *sql.Tx nếu có giao dịch đang mở, ngược lại trả về *sql.DB
func (s *Session) DB() CommonDB {
	if s.tx != nil {
		return s.tx
	}
	return s.db
}
```

Tạo một file mới `session/transaction.go` để đóng gói các interface `Begin`, `Commit` và `Rollback` của transaction. Cách làm này còn giúp ghi log dễ kiểm tra lỗi hơn.

`part-6-transaction/session/transaction.go`

```go
package session

import "geeorm/log"

// Bắt đầu một transaction
func (s *Session) Begin() (err error) {
	log.Info("transaction begin") // Ghi log bắt đầu transaction
	if s.tx, err = s.db.Begin(); err != nil {
		log.Error(err)
		return
	}
	return
}

// Xác nhận transaction (commit)
func (s *Session) Commit() (err error) {
	log.Info("transaction commit") // Ghi log khi commit
	if err = s.tx.Commit(); err != nil {
		log.Error(err)
	}
	return
}

// Huỷ transaction (rollback)
func (s *Session) Rollback() (err error) {
	log.Info("transaction rollback") // Ghi log khi rollback
	if err = s.tx.Rollback(); err != nil {
		log.Error(err)
	}
	return
}
```

Gọi `s.db.Begin()` để lấy đối tượng `*sql.Tx` và gán nó cho `s.tx`.

Trong bước cuối, ta tạo một hàm Transaction để giúp người dùng dễ sử dụng. Họ chỉ cần viết toàn bộ thao tác trong một hàm callback và truyền nó như một tham số đầu vào cho `engine.Transaction()`

`part-6-transaction/geeorm.go`

```go
package geeorm

import "geeorm/session"

// TxFunc là kiểu hàm callback nhận vào một Session
type TxFunc func(*session.Session) (interface{}, error)

// Hàm Transaction thực thi TxFunc trong một transaction
func (engine *Engine) Transaction(f TxFunc) (result interface{}, err error) {
	s := engine.NewSession()        // Tạo session mới
	if err := s.Begin(); err != nil {
		return nil, err
	}

	// Đảm bảo sau khi thực thi sẽ xử lý rollback hoặc commit đúng cách
	defer func() {
		if p := recover(); p != nil {
			_ = s.Rollback() // Nếu panic, rollback
			panic(p)         // Sau đó panic lại
		} else if err != nil {
			_ = s.Rollback() // Nếu có lỗi, rollback
		} else {
			err = s.Commit() // Không có lỗi, commit
		}
	}()

	// Thực thi hàm người dùng truyền vào
	return f(s)
}
```

Nếu có bất kỳ lỗi nào xảy ra, nó sẽ tự động rollback. Nếu không có lỗi, nó sẽ commit.

**Cách sử dụng từ phía người dùng**
Người dùng chỉ cần gói các thao tác trong một hàm và gọi:
```go
engine.Transaction(func(s *Session) (interface{}, error) {
    // Thực hiện các thao tác DB ở đây
    // Nếu lỗi, chỉ cần return error, transaction sẽ rollback
    // Nếu thành công, sẽ được tự động commit
    return nil, nil
})
```
## 4. Kiểm thử

Trong phần này, chúng ta sẽ viết các hàm kiểm thử để đảm bảo tính năng Transaction hoạt động đúng như mong đợi. Cụ thể, ta sẽ kiểm tra hai trường hợp: khi rollback (huỷ giao dịch) và khi commit (xác nhận giao dịch).

```go
package geeorm

import (
	"errors"
	"fmt"
	"geeorm/session"
	_ "github.com/mattn/go-sqlite3"
	"testing"
)

func OpenDB(t *testing.T) *Engine {
	t.Helper()
	engine, err := NewEngine("sqlite3", "gee.db")
	if err != nil {
		t.Fatal("failed to connect", err)
	}
	return engine
}

type User struct {
	Name string `geeorm:"PRIMARY KEY"`
	Age  int
}

func TestEngine_Transaction(t *testing.T) {
	t.Run("rollback", func(t *testing.T) {
		transactionRollback(t) // Kiểm tra rollback
	})
	t.Run("commit", func(t *testing.T) {
		transactionCommit(t) // Kiểm tra commit
	})
}
```

#### Trường hợp 1: Rollback

```go
func transactionRollback(t *testing.T) {
	engine := OpenDB(t)
	defer engine.Close()

	s := engine.NewSession()
	_ = s.Model(&User{}).DropTable() // Xoá bảng User nếu tồn tại

	_, err := engine.Transaction(func(s *session.Session) (interface{}, error) {
		_ = s.Model(&User{}).CreateTable()       // Tạo bảng User
		_, err := s.Insert(&User{"Tom", 18})     // Thêm bản ghi
		return nil, errors.New("Error")          // Cố tình trả lỗi để rollback
	})

	// Sau rollback, bảng User sẽ không tồn tại
	if err == nil || s.HasTable() {
		t.Fatal("failed to rollback")
	}
}
```
**Giải thích**
Trong hàm này, ta cố tình trả về lỗi sau khi tạo bảng và chèn dữ liệu. Điều này khiến transaction bị rollback, do đó bảng User sẽ không được tạo ra.

#### Trường hợp 2: Commit

```go
func transactionCommit(t *testing.T) {
	engine := OpenDB(t)
	defer engine.Close()

	s := engine.NewSession()
	_ = s.Model(&User{}).DropTable() // Xoá bảng User nếu tồn tại

	_, err := engine.Transaction(func(s *session.Session) (interface{}, error) {
		_ = s.Model(&User{}).CreateTable()       // Tạo bảng
		_, err := s.Insert(&User{"Tom", 18})     // Chèn bản ghi
		return nil, err
	})

	u := &User{}
	_ = s.First(u) // Truy vấn bản ghi đầu tiên

	if err != nil || u.Name != "Tom" {
		t.Fatal("failed to commit")
	}
}
```

**Giải thích**
Trong trường hợp này, không có lỗi nào xảy ra nên transaction sẽ được commit. Bảng User sẽ được tạo và dữ liệu được chèn thành công. Sau đó, ta truy vấn lại để kiểm tra dữ liệu.

## 5. Kết luận

Trong bài viết này, chúng ta đã tìm hiểu về transaction trong database, tính chất ACID, cách sử dụng transaction trong Go với thư viện `database/sql`, và cách tích hợp transaction vào GeeORM. Chúng ta cũng đã viết các hàm kiểm thử để đảm bảo tính năng transaction hoạt động đúng như mong đợi. Việc hỗ trợ transaction giúp GeeORM đảm bảo tính toàn vẹn dữ liệu và an toàn trong các thao tác với database.
