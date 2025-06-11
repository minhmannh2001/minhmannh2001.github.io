---
layout: post
title: 'Build your own X: Xây dựng ORM framework với Go - Phần 5'
date: '2025-06-11 21:00'
excerpt: >
  Phần 5 trong chuỗi bài về xây dựng ORM framework với Go. Trong bài này, ta sẽ triển khai cơ chế Hook — cho phép chèn logic trước/sau khi thực hiện các thao tác CRUD như truy vấn, thêm, sửa, xóa.
comments: false
---

# Phần 5: Hooks – Thêm hàm xử lý trước và sau thao tác dữ liệu

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ năm trong loạt hướng dẫn tự xây dựng ORM framework GeeORM với Go trong 7 ngày.

Ở phần này, chúng ta sẽ tìm hiểu về **Hooks** – cơ chế giúp bạn dễ dàng bổ sung các đoạn logic tự động thực thi trước hoặc sau khi thao tác với database như `Insert`, `Query`, `Update`, hay `Delete`.

## 1. Hooks là gì?

`Hook` là những hàm đặc biệt mà bạn có thể định nghĩa trong struct của mình. Khi bạn định nghĩa một struct đại diện cho một bảng dữ liệu (ví dụ: User, Account…), bạn có thể thêm các hàm với tên đặc biệt như `BeforeInsert`, `AfterQuery` vào struct đó. Khi ORM thực hiện các thao tác như thêm, sửa, truy vấn dữ liệu, nó sẽ tự động gọi các hàm này nếu chúng tồn tại.

Ví dụ:
```go
type Account struct {
    ID       int
    Password string
}

// Hàm này sẽ tự động được gọi trước khi dữ liệu Account được thêm vào database
func (a *Account) BeforeInsert(s *Session) error {
    a.ID += 1000
    return nil
}

// Hàm này sẽ tự động được gọi sau khi dữ liệu Account được truy vấn từ database
func (a *Account) AfterQuery(s *Session) error {
    a.Password = "******"
    return nil
}
```
Như vậy, bạn chỉ cần định nghĩa các hàm này trong struct, ORM sẽ tự động nhận biết và gọi chúng vào đúng thời điểm mà không cần bạn phải gọi thủ công. Điều này giúp bạn dễ dàng kiểm soát và bổ sung logic cho từng bước xử lý dữ liệu.

Hooks không chỉ xuất hiện trong ORM mà còn phổ biến ở nhiều hệ thống khác, ví dụ:
- Travis CI tự động build mỗi khi bạn git push
- IDE tự động định dạng lại code khi bạn nhấn Ctrl + S
- Frontend tự động reload khi bạn chỉnh sửa file

Trong GeeORM, các loại hook được hỗ trợ bao gồm:

```go
const (
    BeforeQuery
    AfterQuery
    BeforeUpdate
    AfterUpdate
    BeforeDelete
    AfterDelete
    BeforeInsert
    AfterInsert
)
```

## 2. Cách hoạt động của Hook trong GeeORM

Hooks trong GeeORM được thực thi thông qua hàm CallMethod(), sử dụng reflection để kiểm tra và gọi các hàm hook nếu chúng được định nghĩa trong struct. Nếu struct không có hàm hook tương ứng, hàm này sẽ bỏ qua mà không gây lỗi.

```go
// CallMethod sẽ tìm và gọi hàm hook (nếu có) với tên method trên struct value.
// Nếu value là nil, sẽ tìm trên struct gốc (Model).
func (s *Session) CallMethod(method string, value interface{}) {
    // Lấy hàm method từ struct gốc (Model)
    fm := reflect.ValueOf(s.RefTable().Model).MethodByName(method)
    // Nếu truyền vào value (ví dụ: một instance cụ thể), ưu tiên tìm method trên value đó
    if value != nil {
        fm = reflect.ValueOf(value).MethodByName(method)
    }
    // Chuẩn bị tham số truyền vào cho hook (ở đây là *Session)
    param := []reflect.Value{reflect.ValueOf(s)}
    // Nếu tìm thấy method hợp lệ thì gọi
    if fm.IsValid() {
        // Gọi method và kiểm tra kết quả trả về (nếu có lỗi thì log)
        if v := fm.Call(param); len(v) > 0 {
            if err, ok := v[0].Interface().(error); ok {
                log.Error(err)
            }
        }
    }
}
```
> **Vì sao ưu tiên tìm method trên instance cụ thể?**
> Khi gọi hook, GeeORM ưu tiên tìm và gọi method trên instance cụ thể (ví dụ: một bản ghi dữ liệu) thay vì chỉ trên struct gốc (Model). Lý do là mỗi instance có thể ghi đè hoặc bổ sung hành vi riêng biệt cho từng đối tượng. Điều này giúp bạn linh hoạt hơn, chẳng hạn:
> - Nếu bạn có nhiều loại tài khoản (Account) với các hành vi khác nhau, bạn có thể định nghĩa các hook khác nhau cho từng instance mà không ảnh hưởng đến toàn bộ struct.
> - Việc này cũng cho phép bạn kiểm soát logic xử lý ở mức từng bản ghi, thay vì áp dụng chung cho tất cả.
>
> Nhờ đó, ORM sẽ luôn gọi đúng logic phù hợp với từng trường hợp cụ thể, giúp code của bạn dễ mở rộng và bảo trì hơn.

**Ví dụ: sử dụng hook trong Find**
Trong hàm Find(), GeeORM sẽ gọi BeforeQuery trước khi thực hiện truy vấn, và gọi AfterQuery cho từng dòng dữ liệu sau khi đọc xong.
```go
func (s *Session) Find(values interface{}) error {
    // Gọi hook BeforeQuery trước khi truy vấn
    s.CallMethod(BeforeQuery, nil)
    // ...
    for rows.Next() {
        dest := reflect.New(destType).Elem()
        // ... (đọc dữ liệu vào dest)
        // Gọi hook AfterQuery cho từng bản ghi vừa đọc
        s.CallMethod(AfterQuery, dest.Addr().Interface())
    }
    return rows.Close()
}
```
Nhờ cách này, bạn có thể dễ dàng chèn thêm logic vào trước hoặc sau các thao tác với database chỉ bằng cách định nghĩa các hàm hook tương ứng trong struct của mình.
## 3. Ví dụ và kiểm thử hook trong GeeORM

#### Định nghĩa struct với hook

Dưới đây là ví dụ struct `Account` có hai hook:

- **BeforeInsert:** Tự động cộng thêm 1000 vào trường ID trước khi lưu vào database.
- **AfterQuery:** Tự động ẩn mật khẩu sau khi lấy dữ liệu từ database.

```go
type Account struct {
    ID       int    `geeorm:"PRIMARY KEY"`
    Password string
}

// Hook này sẽ được gọi trước khi insert vào database.
// Ở đây, ID sẽ được cộng thêm 1000.
func (a *Account) BeforeInsert(s *Session) error {
    log.Info("before insert", a)
    a.ID += 1000
    return nil
}

// Hook này sẽ được gọi sau khi truy vấn dữ liệu từ database.
// Ở đây, Password sẽ được thay bằng chuỗi "******".
func (a *Account) AfterQuery(s *Session) error {
    log.Info("after query", a)
    a.Password = "******"
    return nil
}
```

#### Kiểm thử hook

Tạo file mới session/hooks_test.go và thêm test case sau để kiểm tra hoạt động của hai hook này:

```go
package session

import (
    "geeorm/log"
    "testing"
)

func TestSession_CallMethod(t *testing.T) {
    s := NewSession().Model(&Account{})
    _ = s.DropTable()
    _ = s.CreateTable()
    // Insert hai account, BeforeInsert sẽ cộng thêm 1000 vào ID
    _, _ = s.Insert(&Account{1, "123456"}, &Account{2, "qwerty"})

    u := &Account{}
    // Truy vấn bản ghi đầu tiên, AfterQuery sẽ ẩn mật khẩu
    err := s.First(u)
    if err != nil || u.ID != 1001 || u.Password != "******" {
        t.Fatal("Failed to call hooks after query, got", u)
    }
}
```

**Giải thích:**

- Khi gọi Insert, hook BeforeInsert sẽ tự động cộng thêm 1000 vào trường ID của mỗi account.
- Khi gọi First để lấy bản ghi, hook AfterQuery sẽ tự động thay đổi trường Password thành ****** để ẩn thông tin nhạy cảm.
- Test case kiểm tra xem các hook đã hoạt động đúng chưa: ID phải được cộng thêm 1000 và Password phải bị ẩn.

## 4. Kết luận

Hooks giúp bạn tự động hóa các thao tác xử lý dữ liệu mà không cần lặp lại code ở nhiều chỗ, ví dụ như việc ẩn mật khẩu sau khi truy vấn. Nhờ đó, ORM trở nên linh hoạt và mạnh mẽ hơn.

Ở phần tiếp theo, chúng ta sẽ bổ sung tính năng transaction (giao dịch) cho ORM.