---
layout: post
title: 'Build your own X: Xây dựng ORM framework với Go - Phần 4'
date: '2025-06-09 22:30'
excerpt: >
  Phần 4 trong chuỗi bài về xây dựng ORM framework với Go. Trong bài này, ta sẽ triển khai các tính năng như cập nhật, xóa, đếm bản ghi và hỗ trợ gọi chuỗi (chain call) để viết truy vấn gọn gàng hơn.
comments: false
---

# Phần 4: Chain Operation, Update và Delete

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ tư trong loạt bài hướng dẫn xây dựng ORM framework GeeORM từ đầu bằng Go trong 7 ngày.

Ở phần này, chúng ta sẽ tìm hiểu cách sử dụng chain operation để kết hợp nhiều điều kiện truy vấn (where, order by, limit, ...) một cách linh hoạt và hiệu quả.

## 1. Hỗ trợ Update, Delete và Count

### 1.1 Clause Generator

`Clause` chịu trách nhiệm xây dựng câu lệnh SQL. Nếu muốn bổ sung các chức năng update, delete, count thì bước đầu tiên là phải triển khai các generator cho các mệnh đề update, delete, count trong clause.

**Bước 1:** Thêm ba giá trị enum mới `UPDATE`, `DELETE`, `COUNT` vào danh sách các loại mệnh đề.

```go
// part-4-chain-operation/clause/clause.go

// Các loại mệnh đề hỗ trợ trong Clause
const (
    INSERT Type = iota
    VALUES
    SELECT
    LIMIT
    WHERE
    ORDERBY
    UPDATE
    DELETE
    COUNT
)
```

**Bước 2:** Triển khai generator cho từng mệnh đề và đăng ký vào biến toàn cục generators.

```go
// part-4-chain-operation/clause/generator.go

func init() {
    generators = make(map[Type]generator)
    generators[INSERT] = _insert
    generators[VALUES] = _values
    generators[SELECT] = _select
    generators[LIMIT] = _limit
    generators[WHERE] = _where
    generators[ORDERBY] = _orderBy
    generators[UPDATE] = _update
    generators[DELETE] = _delete
    generators[COUNT] = _count
}

// _update tạo ra câu lệnh SQL UPDATE và danh sách các biến cho câu lệnh đó.
// Tham số:
//   - values[0]: Tên của bảng cần cập nhật (string).
//   - values[1]: Một map[string]interface{} chứa các cặp key-value cần cập nhật.
//     Key là tên cột, value là giá trị mới của cột đó.
// Kết quả:
//   - Một chuỗi chứa câu lệnh SQL UPDATE.
//   - Một slice interface{} chứa các giá trị tương ứng với các placeholder "?" trong câu lệnh SQL.
func _update(values ...interface{}) (string, []interface{}) {
    tableName := values[0]
    m := values[1].(map[string]interface{})
    var keys []string
    var vars []interface{}
    for k, v := range m {
        keys = append(keys, k+" = ?")
        vars = append(vars, v)
    }
    return fmt.Sprintf("UPDATE %s SET %s", tableName, strings.Join(keys, ", ")), vars
}

// _delete tạo ra câu lệnh SQL DELETE.
// Tham số:
//   - values[0]: Tên của bảng cần xóa (string).
// Kết quả:
//   - Một chuỗi chứa câu lệnh SQL DELETE.
//   - Một slice interface{} rỗng.
func _delete(values ...interface{}) (string, []interface{}) {
    return fmt.Sprintf("DELETE FROM %s", values[0]), []interface{}{}
}

// _count tạo ra câu lệnh SQL SELECT COUNT(*).
// Tham số:
//   - values[0]: Tên của bảng cần đếm (string).
// Kết quả:
//   - Một chuỗi chứa câu lệnh SQL SELECT COUNT(*).
//   - Một slice interface{} rỗng.
func _count(values ...interface{}) (string, []interface{}) {
    return _select(values[0], []string{"count(*)"})
}
```
##### Ví dụ minh họa cho từng generator

- **UPDATE**
Gọi: `_update("User", map[string]interface{}{"name": "Tom", "age": 18})`  
Kết quả:
    - Chuỗi SQL: `UPDATE User SET name = ?, age = ?`
    - Tham số: `[]interface{}{"Tom", 18}`

- **DELETE**
Gọi: `_delete("User")`  
Kết quả:
    - Chuỗi SQL: `DELETE FROM User`
    - Tham số: `[]interface{}{}`

- **COUNT**
Gọi: `_count("User")`  
Kết quả:
    - Chuỗi SQL: `SELECT count(*) FROM User`
    - Tham số: `[]interface{}{}`

### 1.2 Phương thức Update
Sau khi đã xây dựng generator cho từng mệnh đề SQL, việc thực hiện thao tác Update trở nên đơn giản: chỉ cần kết hợp các clause theo đúng thứ tự rồi thực thi, tương tự như cách ta đã làm với Insert và Find.

```go
// part-4-chain-operation/session/record.go

// Hỗ trợ cả hai kiểu tham số:
// - map[string]interface{}: {"Name": "Tom", "Age": 18}
// - danh sách key-value phẳng: "Name", "Tom", "Age", 18
func (s *Session) Update(kv ...interface{}) (int64, error) {
    // Bước 1: Chuẩn hóa input thành map
    m, ok := kv[0].(map[string]interface{})
    if !ok {
        // Nếu không phải map, chuyển từ danh sách key-value sang map
        m = make(map[string]interface{})
        for i := 0; i < len(kv); i += 2 {
            m[kv[i].(string)] = kv[i+1]
        }
    }

    // Bước 2: Đăng ký mệnh đề UPDATE
    s.clause.Set(clause.UPDATE, s.RefTable().Name, m)

    // Bước 3: Tạo câu SQL từ các mệnh đề UPDATE và WHERE
    sql, vars := s.clause.Build(clause.UPDATE, clause.WHERE)

    // Bước 4: Thực thi câu SQL
    result, err := s.Raw(sql, vars...).Exec()
    if err != nil {
        return 0, err
    }

    // Bước 5: Trả về số dòng bị ảnh hưởng
    return result.RowsAffected()
}
```

Điểm đặc biệt của phương thức Update là tính linh hoạt trong cách nhận tham số. Bạn có thể truyền vào một map[string]interface{} hoặc một chuỗi các cặp key-value. Trong trường hợp không phải map, hàm sẽ tự động chuyển đổi về dạng map trước khi xử lý tiếp. Điều này giúp người dùng linh hoạt hơn khi gọi hàm, đồng thời giữ cho phần xử lý logic bên trong luôn nhất quán.

**Ví dụ sử dụng**
```go
// Cách 1: Sử dụng map
data := map[string]interface{}{
    "Name": "John",
    "Age":  25,
}
rowsAffected, err := session.Update(data)

// Cách 2: Sử dụng danh sách key-value phẳng
rowsAffected, err := session.Update("Name", "John", "Age", 25)
```
Cả hai cách sử dụng trên đều tạo ra cùng một câu SQL UPDATE và cho kết quả giống nhau.
### 1.3 Phương thức Delete
Phương thức Delete dùng để xóa các bản ghi trong bảng dựa trên điều kiện WHERE đã thiết lập trước đó.
```go
// Xóa bản ghi dựa trên mệnh đề WHERE
func (s *Session) Delete() (int64, error) {
    // Bước 1: Đăng ký mệnh đề DELETE với tên bảng
    s.clause.Set(clause.DELETE, s.RefTable().Name)

    // Bước 2: Tạo câu SQL từ DELETE và WHERE clause
    sql, vars := s.clause.Build(clause.DELETE, clause.WHERE)

    // Bước 3: Thực thi câu lệnh SQL
    result, err := s.Raw(sql, vars...).Exec()
    if err != nil {
        return 0, err
    }

    // Bước 4: Trả về số bản ghi bị xóa
    return result.RowsAffected()
}
```

### 1.4 Phương thức Count
Phương thức Count được sử dụng để đếm số lượng bản ghi trong bảng, có thể kết hợp với mệnh đề WHERE để đếm có điều kiện.
```go
// Đếm số bản ghi với mệnh đề WHERE
func (s *Session) Count() (int64, error) {
    // Bước 1: Đăng ký mệnh đề COUNT với tên bảng
    s.clause.Set(clause.COUNT, s.RefTable().Name)

    // Bước 2: Tạo câu SQL từ COUNT và WHERE clause
    sql, vars := s.clause.Build(clause.COUNT, clause.WHERE)

    // Bước 3: Thực thi truy vấn và đọc kết quả
    row := s.Raw(sql, vars...).QueryRow()
    var tmp int64
    if err := row.Scan(&tmp); err != nil {
        return 0, err
    }

    // Bước 4: Trả về số lượng bản ghi
    return tmp, nil
}
```

## 2. Chain Call (Gọi chuỗi)
**Chain call** là một kỹ thuật lập trình giúp viết code ngắn gọn và dễ đọc hơn. Ý tưởng đơn giản là: mỗi phương thức sau khi thực thi sẽ trả về chính đối tượng đó (ở đây là *Session), nhờ vậy ta có thể gọi tiếp các phương thức khác liên tiếp trên cùng một dòng.

Cách xây dựng một câu lệnh SQL rất phù hợp với cách gọi chuỗi này, vì SQL thường có nhiều phần như WHERE, LIMIT, ORDER BY, v.v.

Ví dụ:
```go
s := geeorm.NewEngine("sqlite3", "gee.db").NewSession()
var users []User
s.Where("Age > 18").Limit(3).Find(&users)
```
Câu lệnh trên tương đương với truy vấn:
```sql
SELECT * FROM User WHERE Age > 18 LIMIT 3
```

Các phần như WHERE, LIMIT, ORDER BY là các mệnh đề phổ biến trong SQL,  rất phù hợp để chain call. Ta chỉ cần định nghĩa các phương thức tương ứng trong session/record.go như sau:
```go
// Thêm điều kiện LIMIT vào clause
func (s *Session) Limit(num int) *Session {
    s.clause.Set(clause.LIMIT, num)
    return s
}

// Thêm điều kiện WHERE vào clause
func (s *Session) Where(desc string, args ...interface{}) *Session {
    var vars []interface{}
    s.clause.Set(clause.WHERE, append(append(vars, desc), args...)...)
    return s
}

// Thêm điều kiện ORDER BY vào clause
func (s *Session) OrderBy(desc string) *Session {
    s.clause.Set(clause.ORDERBY, desc)
    return s
}
```

## 3. First - Truy vấn và trả về một bản ghi duy nhất
Trong nhiều trường hợp, ta chỉ cần lấy **một bản ghi duy nhất** từ cơ sở dữ liệu. Ví dụ, truy vấn thông tin của một người dùng theo ID, hoặc lấy bản ghi mới nhất/dữ liệu đầu tiên thỏa mãn điều kiện nào đó.

Để làm điều này, ta có thể tận dụng chain call cùng với hàm Limit(1) và Find() để xây dựng hàm First.

**Định nghĩa hàm `First`:**

```go
func (s *Session) First(value interface{}) error {
    // Chuyển con trỏ value thành giá trị thực
    dest := reflect.Indirect(reflect.ValueOf(value))

    // Tạo một slice tạm thời có cùng kiểu với biến value truyền vào
    destSlice := reflect.New(reflect.SliceOf(dest.Type())).Elem()

    // Gọi Find với giới hạn 1 bản ghi
    if err := s.Limit(1).Find(destSlice.Addr().Interface()); err != nil {
        return err
    }

    // Nếu không tìm thấy bản ghi nào, trả về lỗi
    if destSlice.Len() == 0 {
        return errors.New("NOT FOUND")
    }

    // Lấy phần tử đầu tiên từ slice và gán vào value
    dest.Set(destSlice.Index(0))
    return nil
}
```

**Cách sử dụng:**

```go
u := &User{}
_ = s.OrderBy("Age DESC").First(u)
```
Truy vấn trên tương đương với:
```sql
SELECT * FROM User ORDER BY Age DESC LIMIT 1;
```
Biến u sẽ chứa bản ghi đầu tiên theo thứ tự tuổi giảm dần.

## 4. Kiểm thử
Chúng ta sẽ thêm các test case vào file record_test.go để kiểm tra các phương thức như Limit, Update, Delete, và Count

**Thiết lập dữ liệu test**
```go
package session

import "testing"

var (
    user1 = &User{"Tom", 18}
    user2 = &User{"Sam", 25}
    user3 = &User{"Jack", 25}
)

// Hàm khởi tạo session và tạo dữ liệu mẫu
func testRecordInit(t *testing.T) *Session {
    t.Helper() // Đánh dấu hàm hỗ trợ cho test

    s := NewSession().Model(&User{})

    // Xóa bảng nếu có, tạo lại bảng mới và chèn dữ liệu
    err1 := s.DropTable()
    err2 := s.CreateTable()
    _, err3 := s.Insert(user1, user2)

    if err1 != nil || err2 != nil || err3 != nil {
        t.Fatal("failed init test records") // Báo lỗi nếu setup thất bại
    }
    return s
}
```
**Kiểm tra phương thức `Limit`**
```go
func TestSession_Limit(t *testing.T) {
    s := testRecordInit(t)
    var users []User
    err := s.Limit(1).Find(&users)

    if err != nil || len(users) != 1 {
        t.Fatal("failed to query with limit condition")
    }
}
```
**Kiểm tra phương thức `Update`**
```go
func TestSession_Update(t *testing.T) {
    s := testRecordInit(t)

    // Cập nhật tuổi của user có tên là "Tom" thành 30
    affected, _ := s.Where("Name = ?", "Tom").Update("Age", 30)

    u := &User{}
    _ = s.OrderBy("Age DESC").First(u)

    if affected != 1 || u.Age != 30 {
        t.Fatal("failed to update")
    }
}
```
**Kiểm tra phương thức `Delete` và `Count`**
```go
func TestSession_DeleteAndCount(t *testing.T) {
    s := testRecordInit(t)

    // Xóa user tên là "Tom"
    affected, _ := s.Where("Name = ?", "Tom").Delete()

    // Đếm số lượng bản ghi còn lại
    count, _ := s.Count()

    if affected != 1 || count != 0 {
        t.Fatal("failed to delete or count")
    }
}
```
## 5. Kết luận

Sau phần này, bạn đã nắm được:

- Cách xây dựng các generator cho các mệnh đề UPDATE, DELETE, COUNT trong clause.
- Thêm và sử dụng các phương thức Update, Delete, Count trong Session.
- Áp dụng chain call cho các mệnh đề WHERE, LIMIT, ORDER BY để code ngắn gọn, dễ đọc.
- Cách triển khai hàm First để truy vấn một bản ghi duy nhất.
- Viết các test case kiểm thử các chức năng vừa xây dựng.

Ở các phần tiếp theo, chúng ta sẽ tiếp tục hoàn thiện và mở rộng GeeORM với nhiều tính năng mạnh mẽ hơn nữa. Hãy cùng theo dõi!