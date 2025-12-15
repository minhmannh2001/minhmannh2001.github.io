---
layout: post
title: 'Build your own X: Tự xây dựng một ORM framework với Go - Giới thiệu'
date: '2025-05-28 23:30'
excerpt: >-
  Giới thiệu về chuỗi bài viết mới: Xây dựng một ORM framework từ đầu bằng Go. Tìm hiểu cách ánh xạ đối tượng vào cơ sở dữ liệu quan hệ và triển khai các tính năng như tạo bảng, truy vấn, cập nhật, hooks và transaction.
comments: false
---

# Triển khai ORM framework GeeORM từ đầu bằng Go trong 7 ngày

Sau khi hoàn thành xong chuỗi bài viết về xây dựng web framework, tôi tiếp tục dịch và chia sẻ một chuỗi bài viết mới từ blog geektutu.com - lần này về việc xây dựng một ORM framework từ đầu bằng Go.

## 1. ORM là gì?

![ORM](/img/gee-orm/part-1/orm.png "ORM")

Object Relational Mapping (ORM) là quá trình tự động lưu trữ các đối tượng trong các chương trình ngôn ngữ hướng đối tượng vào cơ sở dữ liệu quan hệ bằng cách sử dụng metadata mô tả ánh xạ giữa đối tượng và cơ sở dữ liệu.

Đối tượng và cơ sở dữ liệu được ánh xạ như thế nào?

| Cơ sở dữ liệu | Ngôn ngữ lập trình hướng đối tượng |
|---------------|-----------------------------------|
| Bảng (Table) | Lớp (class/struct) |
| Bản ghi (record, row) | Đối tượng (object) |
| Trường (field, column) | Thuộc tính đối tượng |

### Ví dụ đơn giản về ORM

![ORM](/img/gee-orm/part-1/table%20and%20object.png "ORM")

Hãy xem một ví dụ cụ thể để hiểu ORM. Đây là cách chúng ta thao tác với cơ sở dữ liệu bằng SQL thuần:

```sql
CREATE TABLE User (ID integer, Name text, Age integer);
INSERT INTO User (ID, Name, Age) VALUES (1, "John", 19);
SELECT * FROM User;
```

Khi sử dụng framework ORM, chúng ta có thể viết:

```go
type User struct {
   ID   int
   Name string
   Age  int
}

orm.CreateTable(&User{})
orm.Save(&User{1, "John", 19})
var users []User
orm.Find(&users)
```

Framework ORM hoạt động như một cầu nối giữa đối tượng và cơ sở dữ liệu. Với ORM, bạn có thể tránh viết SQL rườm rà và thao tác với cơ sở dữ liệu quan hệ đơn giản bằng cách thao tác với các đối tượng.

### Thách thức khi triển khai ORM

Để triển khai một ORM framework, chúng ta cần giải quyết một số thách thức:

#### Làm thế nào để ORM hiểu được cấu trúc đối tượng?

Hãy phân tích cách hoạt động của các phương thức ORM cơ bản:

```go
orm.CreateTable(&User{})
orm.Save(&User{"Tom", 18})
var users []User
orm.Find(&users)
```

- **Phương thức `CreateTable(&User{})`** cần lấy tên của cấu trúc tương ứng `User` làm tên bảng, các biến thành viên `Name` và `Age` làm tên cột từ các tham số, và cũng cần biết các kiểu dữ liệu của từng biến thành viên. Nó phải chuyển đổi kiểu dữ liệu Go thành kiểu dữ liệu SQL tương ứng.

- **Phương thức `Save`** cần biết giá trị của từng biến thành viên để có thể lưu chúng vào cơ sở dữ liệu. Nó phải trích xuất giá trị "Tom" và 18 từ đối tượng, và tạo câu lệnh SQL INSERT phù hợp.

- **Phương thức `Find`** chỉ lấy tên cấu trúc tương ứng, tức là tên bảng `User`, từ slice rỗng được truyền vào `&[]User`, và lấy tất cả các bản ghi từ cơ sở dữ liệu, chuyển đổi chúng thành đối tượng `User`, và thêm chúng vào slice. Nó phải biết cách ánh xạ các cột từ kết quả SQL trở lại thành các trường trong struct Go.

Nếu các phương thức này chỉ chấp nhận tham số kiểu `User`, sẽ dễ dàng để triển khai. Tuy nhiên, framework ORM là phổ quát, có nghĩa là bất kỳ đối tượng hợp lệ nào cũng có thể được chuyển đổi thành bảng và bản ghi trong cơ sở dữ liệu. Ví dụ:

```go
type Account struct {
    Username string
    Password string
}

orm.CreateTable(&Account{})
```

Điều này đặt ra câu hỏi quan trọng: làm thế nào để ORM framework có thể làm việc với bất kỳ kiểu struct nào? Đây là lúc cơ chế phản chiếu (reflection) của Go phát huy tác dụng:

```go
typ := reflect.Indirect(reflect.ValueOf(&Account{})).Type()
fmt.Println(typ.Name()) // Account

for i := 0; i < typ.NumField(); i++ {
    field := typ.Field(i)
    fmt.Println(field.Name) // Username Password
}
```

Đoạn code trên sử dụng reflection để phân tích cấu trúc của struct `Account`:

1. `reflect.ValueOf(&Account{})` - Tạo một đối tượng reflection từ con trỏ đến một struct `Account` mới
2. `reflect.Indirect(...)` - Lấy giá trị mà con trỏ trỏ đến (tương đương với việc dereference con trỏ)
3. `Type()` - Lấy thông tin về kiểu dữ liệu của giá trị
4. `typ.Name()` - Lấy tên của kiểu dữ liệu, trong trường hợp này là "Account"
5. `typ.NumField()` - Lấy số lượng trường trong struct
6. `typ.Field(i)` - Lấy thông tin về trường thứ i trong struct
7. `field.Name` - Lấy tên của trường, trong trường hợp này là "Username" và "Password"

Thông qua reflection, ORM framework có thể:
1. Xác định tên của struct để sử dụng làm tên bảng
2. Duyệt qua tất cả các trường trong struct để tạo cột tương ứng
3. Xác định kiểu dữ liệu của mỗi trường để ánh xạ sang kiểu SQL phù hợp
4. Truy cập giá trị của các trường khi cần lưu dữ liệu
5. Gán giá trị cho các trường khi đọc dữ liệu từ cơ sở dữ liệu

Ngoài việc hiểu cấu trúc đối tượng, một ORM framework còn phải giải quyết nhiều thách thức khác:

1. **Tương thích nhiều cơ sở dữ liệu**: Các câu lệnh SQL của MySQL, PostgreSQL, SQLite có sự khác biệt. ORM cần tương thích với nhiều loại cơ sở dữ liệu.

2. **Migrate cơ sở dữ liệu**: Khi cấu trúc đối tượng thay đổi, cấu trúc bảng cơ sở dữ liệu cần được cập nhật tự động.

3. **Hỗ trợ transaction và các tính năng phức tạp khác**.

## 2. Về GeeORM

GeeORM là một framework ORM đơn giản được xây dựng từ đầu bằng Go, lấy cảm hứng từ xorm và gorm. Mục tiêu chính là hiểu nguyên lý hoạt động của ORM framework.

GeeORM được thiết kế với nguyên tắc "đơn giản và hiệu quả", tập trung vào việc trình bày rõ ràng các khái niệm cốt lõi của một ORM framework. Thay vì cố gắng cung cấp mọi tính năng có thể, GeeORM ưu tiên tính dễ hiểu và dễ mở rộng, giúp người đọc nắm bắt được cách thức hoạt động bên trong của một ORM framework.

### Các tính năng được hỗ trợ

GeeORM hỗ trợ các tính năng cơ bản và nâng cao:

- **Quản lý schema**: Tạo, xóa và di chuyển bảng dựa trên định nghĩa struct.
- **CRUD cơ bản**: Thêm, xóa, truy vấn và sửa đổi bản ghi.
- **Truy vấn nâng cao**: Chuỗi các điều kiện truy vấn, hỗ trợ WHERE, LIMIT, ORDER BY.
- **Khóa chính**: Thiết lập và sử dụng khóa chính cho các thao tác.
- **Hooks**: Chạy code tùy chỉnh trước/sau các thao tác cơ sở dữ liệu (create/update/delete/find).
- **Transaction**: Hỗ trợ transaction để đảm bảo tính toàn vẹn dữ liệu.
- **Migration**: Cập nhật schema cơ sở dữ liệu khi cấu trúc đối tượng thay đổi.

### Ví dụ sử dụng GeeORM

Dưới đây là một ví dụ đơn giản về cách sử dụng GeeORM:

```go
// Khởi tạo engine
engine, _ := geeorm.NewEngine("sqlite3", "gee.db")
defer engine.Close()

// Tạo bảng
engine.CreateTable(&User{})

// Chèn dữ liệu
user := &User{Name: "Tom", Age: 18}
engine.Insert(user)

// Truy vấn
var users []User
engine.Where("age > ?", 10).Find(&users)

// Cập nhật
user.Name = "Jack"
engine.Update(user)

// Xóa
engine.Delete(user)
```

### So sánh với các ORM framework khác

So với các ORM framework phổ biến như GORM, xorm, GeeORM đơn giản hơn nhưng vẫn cung cấp các tính năng cốt lõi. Điểm mạnh của GeeORM không phải là tính đầy đủ của tính năng, mà là tính rõ ràng và dễ hiểu của mã nguồn, giúp người đọc hiểu được cách thức hoạt động bên trong của một ORM framework.

| Tính năng | GeeORM | GORM | xorm |
|-----------|--------|------|------|
| CRUD cơ bản | ✓ | ✓ | ✓ |
| Truy vấn nâng cao | ✓ | ✓ | ✓ |
| Hooks | ✓ | ✓ | ✓ |
| Transaction | ✓ | ✓ | ✓ |
| Migration | ✓ | ✓ | ✓ |
| Quan hệ (1-1, 1-n, n-n) | ✗ | ✓ | ✓ |
| Lazy loading | ✗ | ✓ | ✓ |
| Plugins | ✗ | ✓ | ✓ |

## 3. Nội dung chuỗi bài viết

Chuỗi bài viết này sẽ được chia thành 7 phần, mỗi phần tập trung vào một khía cạnh của ORM framework:

1. **[Phần 1: Cơ bản về Database/SQL](https://minhmannh2001.github.io/2025/06/02/build-your-own-x-orm-framework-in-go-part-1.html)**  
   Tìm hiểu cách kết nối và tương tác với cơ sở dữ liệu trong Go.

2. **[Phần 2: Ánh xạ cấu trúc bảng đối tượng](https://minhmannh2001.github.io/2025/06/03/build-your-own-x-orm-framework-in-go-part-2.html)**  
   Sử dụng reflection để ánh xạ struct Go thành bảng cơ sở dữ liệu.

3. **[Phần 3: Tạo và truy vấn bản ghi](https://minhmannh2001.github.io/2025/06/06/build-your-own-x-orm-framework-in-go-part-3.html)**  
   Triển khai các phương thức để thêm và truy vấn dữ liệu.

4. **[Phần 4: Chain Call (Gọi chuỗi), cập nhật và xóa](https://minhmannh2001.github.io/2025/06/09/build-your-own-x-orm-framework-in-go-part-4.html)**  
   Xây dựng API chuỗi để tạo các truy vấn phức tạp và thực hiện cập nhật/xóa.

5. **[Phần 5: Triển khai Hooks](https://minhmannh2001.github.io/2025/06/11/build-your-own-x-orm-framework-in-go-part-5.html)**  
   Thêm khả năng chạy code tùy chỉnh trước/sau các thao tác cơ sở dữ liệu.

6. **[Phần 6: Hỗ trợ transaction](https://minhmannh2001.github.io/2025/06/14/build-your-own-x-orm-framework-in-go-part-6.html)**  
   Triển khai transaction để đảm bảo tính toàn vẹn dữ liệu.

7. **[Phần 7: Migrate cơ sở dữ liệu](https://minhmannh2001.github.io/2025/06/17/build-your-own-x-orm-framework-in-go-part-7.html)**  
   Tự động cập nhật schema cơ sở dữ liệu khi cấu trúc đối tượng thay đổi.

## 4. Kết luận

Xây dựng một ORM framework từ đầu là một cách tuyệt vời để hiểu sâu về cách hoạt động của cơ sở dữ liệu và cơ chế reflection trong Go. Mặc dù GeeORM không đầy đủ tính năng như các framework thương mại, nhưng nó cung cấp một nền tảng vững chắc để hiểu các nguyên tắc cơ bản.

Hãy theo dõi chuỗi bài viết này để tìm hiểu cách xây dựng ORM framework của riêng bạn!




