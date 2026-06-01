---
layout: post
title: "Build your own X: Xây dựng ORM framework với Go - Phần 7"
date: 2025-06-17 08:00:00 +0700
excerpt: >
  Phần cuối trong chuỗi bài xây dựng ORM framework với Go. Bài viết trình bày cách tự động cập nhật cấu trúc bảng database khi struct thay đổi, thông qua tính năng Migrate — hỗ trợ thêm và xóa field mà không cần viết thủ công câu lệnh SQL.
comments: false
---

# Phần 7: Tự động cập nhật cấu trúc bảng database khi struct thay đổi

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết cuối cùng trong loạt hướng dẫn tự xây dựng ORM framework GeeORM với Go trong 7 ngày. 

Ở phần này, chúng ta sẽ tìm hiểu về cách tự động cập nhật cấu trúc bảng database khi struct thay đổi, thông qua tính năng Migrate — hỗ trợ thêm và xóa field mà không cần viết thủ công câu lệnh SQL.

## Mục tiêu:
- Khi cấu trúc (struct) thay đổi, các trường (field) của bảng database sẽ tự động được migrate (migrate).
- Chỉ hỗ trợ thêm và xóa field, không hỗ trợ thay đổi kiểu dữ liệu của field.

## 1. Sử dụng câu lệnh SQL để Migrate

Database migration luôn là một vấn đề đau đầu đối với các nhân viên vận hành và bảo trì database. Nếu chỉ là thêm hoặc xóa field trong một bảng thì tương đối dễ. Tuy nhiên, nếu liên quan đến các liên kết phức tạp như foreign key, thì database migration sẽ trở nên rất khó khăn.

**Ví dụ:** Giả sử bạn có hai bảng `orders` và `users`, trong đó `orders.user_id` là foreign key tham chiếu đến `users.id`. Nếu bạn muốn đổi tên hoặc xóa cột `user_id`, bạn cần:
- Xóa ràng buộc foreign key trước.
- Thực hiện thay đổi tên cột.
- Sau đó thêm lại foreign key.

Quá trình này không chỉ phức tạp mà còn dễ gây lỗi nếu không cẩn thận, đặc biệt khi dữ liệu đang ở môi trường production.

Thao tác `Migrate` của GeeORM chỉ dành cho các trường hợp đơn giản nhất, tức là chỉ hỗ trợ **thêm** và **xóa** field, chứ không hỗ trợ thay đổi kiểu dữ liệu của field hoặc các trường hợp phức tạp khác.

Trước khi thực hiện `Migrate`, hãy xem cách sử dụng các câu lệnh SQL để thêm hoặc xóa field.

### 1.1 Thêm field mới

```sql
ALTER TABLE table_name ADD COLUMN col_name col_type;
```

Hầu hết các database đều hỗ trợ thêm field mới hoặc đổi tên field bằng cách sử dụng keyword `ALTER`.

### 1.2 Xóa field

Đối với SQLite, việc xóa field không đơn giản như thêm field mới vì SQLite không hỗ trợ trực tiếp lệnh DROP COLUMN. Một giải pháp thay thế là tạo bảng mới chỉ chứa các field cần giữ lại, sau đó thay thế bảng cũ bằng bảng mới.

```sql
CREATE TABLE new_table AS SELECT col1, col2, ... from old_table;
DROP TABLE old_table;
ALTER TABLE new_table RENAME TO old_table;
```
**Các bước thực hiện:**
1. **Chọn dữ liệu cần giữ**: Tạo bảng mới (`new_table`) chỉ chứa các cột bạn muốn giữ lại từ bảng gốc (`old_table`).
2. **Xóa bảng cũ:** Xóa bảng gốc để tránh trùng tên.
3. **Đổi tên bảng mới:** Đổi tên `new_table` thành `old_table` để giữ nguyên tên bảng cũ trong hệ thống.

> ⚠️ Dữ liệu cũ có được giữ lại không?
> Có - dữ liệu trong các cột được giữ lại (col1, col2, ...) vẫn còn nguyên. Tuy nhiên, toàn bộ dữ liệu trong các cột bị loại bỏ sẽ mất. Do đó, bạn cần chắc chắn rằng việc loại bỏ field là cần thiết và dữ liệu không còn quan trọng. Nếu cần, bạn nên backup bảng gốc trước khi thực hiện thao tác này.

## 2. GeeORM thực hiện Migrate

Dựa trên các câu lệnh SQL đã trình bày, GeeORM cài đặt chức năng `Migrate` để tự động cập nhật cấu trúc bảng database sao cho khớp với struct trong Go. Quá trình này được bao bọc trong một transaction (đã xây dựng ở phần 6) nhằm đảm bảo rằng nếu có lỗi xảy ra giữa chừng, toàn bộ thay đổi sẽ được rollback, giúp dữ liệu không bị sai lệch hay mất mát.

```go
package geeorm

import (
	"fmt"
	"geeorm/log"
	"geeorm/session"
	"reflect"
	"strings"
)

// Hàm này trả về các phần tử thuộc a nhưng không có trong b
func difference(a []string, b []string) (diff []string) {
	mapB := make(map[string]bool)
	for _, v := range b {
		mapB[v] = true
	}
	for _, v := range a {
		if _, ok := mapB[v]; !ok {
			diff = append(diff, v)
		}
	}
	return
}

// Migrate table
func (engine *Engine) Migrate(value interface{}) error {
	_, err := engine.Transaction(func(s *session.Session) (result interface{}, err error) {
		// Nếu bảng chưa tồn tại, tạo bảng mới luôn
		if !s.Model(value).HasTable() {
			log.Infof("table %s doesn't exist", s.RefTable().Name)
			return nil, s.CreateTable()
		}

		// Lấy metadata của bảng hiện tại
		table := s.RefTable()

		// Truy vấn để lấy danh sách các column đang có trong bảng
		rows, _ := s.Raw(fmt.Sprintf("SELECT * FROM %s LIMIT 1", table.Name)).QueryRows()
		columns, _ := rows.Columns()

		// So sánh với struct để tìm các field mới cần thêm và các field cũ cần xóa
		addCols := difference(table.FieldNames, columns)
		delCols := difference(columns, table.FieldNames)
		log.Infof("added cols %v, deleted cols %v", addCols, delCols)

		// Thêm các field mới bằng ALTER TABLE
		for _, col := range addCols {
			f := table.GetField(col)
			sqlStr := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s;", table.Name, f.Name, f.Type)
			if _, err = s.Raw(sqlStr).Exec(); err != nil {
				return
			}
		}

		// Nếu không có field nào cần xóa thì kết thúc sớm
		if len(delCols) == 0 {
			return
		}

		// Xử lý xóa field: tạo bảng mới chỉ giữ lại field cần thiết
		tmp := "tmp_" + table.Name
		fieldStr := strings.Join(table.FieldNames, ", ")
		s.Raw(fmt.Sprintf("CREATE TABLE %s AS SELECT %s FROM %s;", tmp, fieldStr, table.Name))
		s.Raw(fmt.Sprintf("DROP TABLE %s;", table.Name))
		s.Raw(fmt.Sprintf("ALTER TABLE %s RENAME TO %s;", tmp, table.Name))
		_, err = s.Exec()
		return
	})
	return err
}
```

**Giải thích chi tiết**
- `difference`: Hàm này dùng để tìm sự khác biệt giữa hai danh sách tên cột. Nếu so sánh struct mới với bảng cũ, ta biết được những cột cần thêm hoặc cần xóa.
- Thêm cột mới được xử lý bằng lệnh `ALTER TABLE ... ADD COLUMN ...`.
- Việc xóa cột được thực hiện gián tiếp bằng cách tạo một bảng tạm chỉ chứa các cột cần giữ lại, sau đó thay thế bảng cũ bằng bảng này.

## 3. Kiểm thử

Để kiểm tra tính năng Migrate, thêm đoạn test sau vào file `geeorm_test.go`:

```go
package geeorm

import (
	"fmt"
	"geeorm/log"
	"geeorm/session"
	"reflect"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

type User struct {
	Name string `geeorm:"PRIMARY KEY"`
	Age  int
}

func TestEngine_Migrate(t *testing.T) {
	engine := OpenDB(t)
	defer engine.Close()
	s := engine.NewSession()

	// Tạo bảng ban đầu với cột không khớp với struct
	_, _ = s.Raw("DROP TABLE IF EXISTS User;").Exec()
	_, _ = s.Raw("CREATE TABLE User(Name text PRIMARY KEY, XXX integer);").Exec()
	_, _ = s.Raw("INSERT INTO User(`Name`) values (?), (?)", "Tom", "Sam").Exec()

	// Gọi migrate để cập nhật bảng cho khớp với struct mới
	engine.Migrate(&User{})

	// Kiểm tra cấu trúc bảng sau khi migrate
	rows, _ := s.Raw("SELECT * FROM User").QueryRows()
	columns, _ := rows.Columns()
	if !reflect.DeepEqual(columns, []string{"Name", "Age"}) {
		t.Fatal("Failed to migrate table User, got columns", columns)
	}
}
```

Trong ví dụ này:
- Bảng ban đầu có hai cột: Name và XXX.
- Struct User mới có hai field: Name và Age.
- Khi gọi Migrate, GeeORM sẽ tự động xóa cột XXX và thêm cột Age.

Cuối cùng, đoạn test sẽ kiểm tra xem bảng User đã khớp với struct chưa bằng cách so sánh tên các cột.

## 4. Kết luận

Sau 7 phần, chúng ta đã cùng nhau xây dựng một ORM framework đơn giản có tên GeeORM, từ những chức năng cơ bản nhất như kết nối và thao tác với database, cho đến những tính năng nâng cao hơn như transaction và migrate bảng. Tuy GeeORM còn khá sơ khai và chỉ xử lý được các trường hợp đơn giản (như thêm/xóa field, chưa hỗ trợ foreign key, struct lồng nhau hay composite primary key), nhưng đó cũng chính là mục tiêu của dự án: làm rõ các nguyên lý cốt lõi khi xây dựng một ORM framework.

Trên thực tế, một ORM production-ready thường có codebase rất lớn. Để hỗ trợ nhiều loại database khác nhau với các đặc điểm riêng, xử lý được đa dạng tình huống phức tạp và đảm bảo hiệu suất cao, bạn cần viết rất nhiều đoạn code đặc thù. Một số ORM hiện đại thậm chí còn hỗ trợ cả relational và non-relational database, yêu cầu mức độ trừu tượng cao vượt ngoài phạm vi SQL đơn thuần.

Tuy chỉ vỏn vẹn khoảng 800 dòng code, GeeORM vẫn truyền tải được những nguyên tắc quan trọng mà một ORM cần có, chẳng hạn như:

- Cách trừu tượng hóa sự khác biệt giữa các hệ quản trị cơ sở dữ liệu;
- Cách ánh xạ bảng dữ liệu với các struct trong ngôn ngữ lập trình;
- Cách mô phỏng các truy vấn SQL bằng method chaining để tạo API thân thiện;
- Lý do các ORM thường cung cấp hook để mở rộng hành vi;
- Cách ORM xử lý transaction một cách an toàn;
- Và những thách thức khi thực hiện tính năng database migration.

Tóm lại, GeeORM không được thiết kế để thay thế các ORM thực tế, mà đóng vai trò như một ví dụ nhỏ gọn và dễ hiểu, giúp bạn nắm bắt rõ cách một ORM hoạt động bên trong. Khi đã hiểu được cơ chế của GeeORM, bạn sẽ tự tin hơn khi sử dụng, mở rộng hoặc thậm chí tự xây dựng các framework ORM trong các dự án thực tế.

Hy vọng chuỗi bài viết này đã mang lại cho bạn nhiều kiến thức hữu ích và truyền cảm hứng để khám phá sâu hơn về lập trình hệ thống, framework và cơ sở dữ liệu. Cảm ơn bạn đã đồng hành đến cuối series này — và đừng quên theo dõi các series tiếp theo, nơi chúng ta sẽ cùng tìm hiểu thêm nhiều chủ đề thú vị khác trong thế giới lập trình!
