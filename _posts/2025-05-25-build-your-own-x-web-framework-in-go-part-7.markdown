---
layout: post
title: 'Build your own X: Tự xây dựng web framework với Go - Phần 7'
date: '2025-05-25 20:30'
excerpt: >-
  Phần cuối cùng trong chuỗi bài về xây dựng web framework với Go. Bài viết này tập trung vào việc hỗ trợ phục vụ tài nguyên tĩnh và render template HTML - hai tính năng quan trọng cho phát triển web server-side.
comments: false
---

# Phần 7: Phục vụ tài nguyên tĩnh và Render Template HTML

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Chào mừng bạn đến với bài viết cuối cùng trong chuỗi bài hướng dẫn xây dựng web framework Gee từ đầu bằng Go trong 7 ngày.

## Mục tiêu của bài viết này

- Triển khai phục vụ tài nguyên tĩnh (Static Resource)
- Hỗ trợ render template HTML

## Server-side rendering

Hiện nay, mô hình phát triển tách biệt frontend và backend đang ngày càng phổ biến. Trong mô hình này, backend cung cấp các API RESTful và trả về dữ liệu có cấu trúc (thường là JSON hoặc XML), trong khi frontend sử dụng công nghệ AJAX để lấy dữ liệu và JavaScript để render giao diện. Các framework frontend như Vue/React ngày càng được ưa chuộng.

Mô hình phát triển này có những ưu điểm nổi bật:
- Frontend và backend được tách biệt hoàn toàn
- Backend tập trung vào việc xử lý tài nguyên, xử lý đồng thời và cơ sở dữ liệu
- Frontend tập trung vào thiết kế và triển khai giao diện
- Một bộ backend có thể hỗ trợ đồng thời nhiều nền tảng: web, mobile app, mini app...

Tuy nhiên, một vấn đề lớn của việc tách biệt frontend và backend là trang web được render ở phía client (như trình duyệt), điều này không thân thiện với các công cụ crawler. Mặc dù Google crawler hiện đã có thể crawl các trang web được render bằng JavaScript, nhưng trong ngắn hạn, việc crawl các trang HTML được render trực tiếp từ server vẫn là xu hướng chính.

Trong bài viết này, chúng ta sẽ tìm hiểu cách web framework hỗ trợ kịch bản render phía server.

## Phục vụ tài nguyên tĩnh

JavaScript, CSS và HTML được coi là "bộ ba" không thể thiếu của trang web. Để thực hiện server-side rendering, bước đầu tiên là hỗ trợ các tệp tĩnh như JS và CSS.

Nhớ lại khi chúng ta thiết kế định tuyến động trước đây, chúng ta đã hỗ trợ ký tự đại diện `*` để khớp với nhiều cấp đường dẫn con. Ví dụ, quy tắc định tuyến `/assets/*filepath` có thể khớp với tất cả các địa chỉ bắt đầu bằng `/assets/`. Ví dụ `/assets/js/geektutu.js`, sau khi khớp, tham số `filepath` được gán giá trị `js/geektutu.js`.

Nếu chúng ta đặt tất cả các tệp tĩnh trong một thư mục, chẳng hạn như `/usr/web`, thì giá trị `filepath` là địa chỉ tương đối của tệp trong thư mục đó. Sau khi ánh xạ đến tệp thực tế, tệp được trả về, và máy chủ tĩnh được thực hiện.

Sau khi tìm thấy tệp, thư viện `net/http` đã triển khai sẵn cách trả về tệp. Do đó, tất cả những gì framework Gee cần làm là phân tích địa chỉ được yêu cầu, ánh xạ nó đến địa chỉ thực của tệp trên máy chủ, và để `http.FileServer` xử lý phần còn lại.

```go
// Tạo handler cho tài nguyên tĩnh
func (group *RouterGroup) createStaticHandler(relativePath string, fs http.FileSystem) HandlerFunc {
    absolutePath := path.Join(group.prefix, relativePath)
    fileServer := http.StripPrefix(absolutePath, http.FileServer(fs))
    return func(c *Context) {
        file := c.Param("filepath")
        // Kiểm tra xem tệp có tồn tại và/hoặc chúng ta có quyền truy cập không
        if _, err := fs.Open(file); err != nil {
            c.Status(http.StatusNotFound)
            return
        }

        fileServer.ServeHTTP(c.Writer, c.Req)
    }
}

// Phục vụ tệp tĩnh
func (group *RouterGroup) Static(relativePath string, root string) {
    handler := group.createStaticHandler(relativePath, http.Dir(root))
    urlPattern := path.Join(relativePath, "/*filepath")
    // Đăng ký handler GET
    group.GET(urlPattern, handler)
}
```

Chúng ta đã thêm hai phương thức vào `RouterGroup` mà người dùng có thể sử dụng. Người dùng có thể ánh xạ một thư mục trên đĩa `root` đến một route `relativePath`. Ví dụ:

```go
r := gee.New() 
r.Static("/assets", "/usr/geektutu/blog/static") 
// hoặc đường dẫn tương đối
r.Static("/assets", "./static")
r.Run(":9999")
```

Khi người dùng truy cập `localhost:9999/assets/js/geektutu.js`, framework sẽ trả về tệp `/usr/geektutu/blog/static/js/geektutu.js`.

## Render template HTML

Ngôn ngữ Go có hai thư viện template chuẩn: `text/template` và `html/template`. Trong đó, `html/template` cung cấp hỗ trợ tương đối đầy đủ cho HTML, bao gồm render biến thông thường, render danh sách, render đối tượng, v.v. Việc render template của framework Gee sẽ sử dụng trực tiếp các khả năng được cung cấp bởi `html/template`.

```go
type Engine struct {
    *RouterGroup
    router        *router
    groups        []*RouterGroup     // lưu trữ tất cả các nhóm
    htmlTemplates *template.Template // cho render HTML
    funcMap       template.FuncMap   // cho render HTML
}

func (engine *Engine) SetFuncMap(funcMap template.FuncMap) {
    engine.funcMap = funcMap
}

func (engine *Engine) LoadHTMLGlob(pattern string) {
    engine.htmlTemplates = template.Must(template.New("").Funcs(engine.funcMap).ParseGlob(pattern))
}
```

Đầu tiên, chúng ta thêm các đối tượng `*template.Template` và `template.FuncMap` vào cấu trúc `Engine`. Đối tượng đầu tiên tải tất cả các template vào bộ nhớ, và đối tượng thứ hai chứa tất cả các hàm render template tùy chỉnh.

Ngoài ra, chúng ta cung cấp cho người dùng các phương thức để thiết lập hàm render tùy chỉnh (`funcMap`) và tải template.

Tiếp theo, chúng ta thực hiện một số sửa đổi nhỏ đối với phương thức `(*Context).HTML()` ban đầu để hỗ trợ việc chọn template để render dựa trên tên tệp template.

```go
type Context struct {
    // ...
    // con trỏ đến engine
    engine *Engine
}

func (c *Context) HTML(code int, name string, data interface{}) {
    c.SetHeader("Content-Type", "text/html")
    c.Status(code)
    if err := c.engine.htmlTemplates.ExecuteTemplate(c.Writer, name, data); err != nil {
        c.Fail(500, err.Error())
    }
}
```

Chúng ta đã thêm biến thành viên `engine *Engine` vào `Context`, để có thể truy cập template HTML trong `Engine` thông qua `Context`. Khi khởi tạo `Context`, chúng ta cũng cần gán giá trị cho `c.engine`.

```go
func (engine *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    // ...
    c := newContext(w, req)
    c.handlers = middlewares
    c.engine = engine
    engine.router.handle(c)
}
```

## Demo sử dụng

Cấu trúc thư mục cuối cùng:

```
---gee/
---static/
   |---css/
        |---geektutu.css
   |---file1.txt
---templates/
   |---arr.tmpl
   |---css.tmpl
   |---custom_func.tmpl
---main.go
```

Ví dụ về một template:

```html
<!-- templates/css.tmpl -->
<html>
    <link rel="stylesheet" href="/assets/css/geektutu.css">
    <p>geektutu.css đã được tải</p>
</html>
```

Mã nguồn chính:

```go
type student struct {
    Name string
    Age  int8
}

func FormatAsDate(t time.Time) string {
    year, month, day := t.Date()
    return fmt.Sprintf("%d-%02d-%02d", year, month, day)
}

func main() {
    r := gee.New()
    r.Use(gee.Logger())
    r.SetFuncMap(template.FuncMap{
        "FormatAsDate": FormatAsDate,
    })
    r.LoadHTMLGlob("templates/*")
    r.Static("/assets", "./static")

    stu1 := &student{Name: "Geektutu", Age: 20}
    stu2 := &student{Name: "Jack", Age: 22}
    r.GET("/", func(c *gee.Context) {
        c.HTML(http.StatusOK, "css.tmpl", nil)
    })
    r.GET("/students", func(c *gee.Context) {
        c.HTML(http.StatusOK, "arr.tmpl", gee.H{
            "title":  "gee",
            "stuArr": [2]*student{stu1, stu2},
        })
    })

    r.GET("/date", func(c *gee.Context) {
        c.HTML(http.StatusOK, "custom_func.tmpl", gee.H{
            "title": "gee",
            "now":   time.Date(2019, 8, 17, 0, 0, 0, 0, time.UTC),
        })
    })

    r.Run(":9999")
}
```

Khi truy cập trang chủ, template được render bình thường và tệp CSS tĩnh được tải thành công.

## Tổng kết

Trong phần cuối cùng này, chúng ta đã hoàn thiện framework Gee bằng cách thêm hai tính năng quan trọng:

1. **Phục vụ tài nguyên tĩnh**: Cho phép framework phục vụ các tệp tĩnh như CSS, JavaScript và hình ảnh.
2. **Render template HTML**: Hỗ trợ render template HTML với các biến động và hàm tùy chỉnh.

Qua 7 phần, chúng ta đã xây dựng một web framework đầy đủ tính năng từ đầu, bao gồm:

- Xử lý HTTP request/response cơ bản
- Định tuyến động với tham số
- Nhóm route và middleware
- Render template HTML
- Phục vụ tài nguyên tĩnh

Framework Gee mà chúng ta đã xây dựng có thể được sử dụng để phát triển các ứng dụng web thực tế, mặc dù nó vẫn còn đơn giản hơn nhiều so với các framework thương mại như Gin hay Echo. Tuy nhiên, quá trình xây dựng framework này đã giúp chúng ta hiểu sâu hơn về cách hoạt động bên trong của một web framework và các khái niệm quan trọng trong phát triển web.

Hy vọng chuỗi bài viết này đã mang lại cho bạn những kiến thức bổ ích và cảm hứng để tiếp tục khám phá thế giới phát triển web với Go!