---
layout: post
title: 'Build your own X: Tự xây dựng web framework với Go - Phần 6'
date: '2025-05-23 20:24'
excerpt: >-
  Phần 6 trong chuỗi bài về xây dựng web framework với Go. Bài viết này tập trung vào việc hỗ trợ phục vụ tài nguyên tĩnh và render template HTML - hai tính năng quan trọng cho phát triển web server-side.
comments: false
---

# Phần 6: Phục vụ tài nguyên tĩnh và Render Template HTML

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ sáu trong loạt bài hướng dẫn xây dựng web framework Gee từ đầu bằng Go trong 7 ngày.

## Mục tiêu của bài viết này

- Triển khai phục vụ tài nguyên tĩnh (Static Resource)
- Hỗ trợ render template HTML

## 1. Server-side rendering và Client-side rendering

Trong phát triển web, có hai phương pháp chính để hiển thị nội dung: Server-side Rendering (SSR) và Client-side Rendering (CSR). Mỗi phương pháp có những ưu điểm và nhược điểm riêng, phù hợp với các tình huống khác nhau.

<div style="text-align: center; margin: 20px 0;">
  <img src="/img/gee-web/part-6/server-side-rendering-diagram.webp" alt="Luồng xử lý của Server-side Rendering" style="max-width: 100%; height: auto;">
  <p><em>Luồng xử lý của Server-side Rendering</em></p>
</div>

<div style="text-align: center; margin: 20px 0;">
  <img src="/img/gee-web/part-6/client-side-rendering-diagram.webp" alt="Luồng xử lý của Client-side Rendering" style="max-width: 100%; height: auto;">
  <p><em>Luồng xử lý của Client-side Rendering</em></p>
</div>

### So sánh SSR và CSR

| Server-side Rendering (SSR) | Client-side Rendering (CSR) |
|----------------------------|----------------------------|
| HTML được tạo hoàn chỉnh từ server | HTML cơ bản được tải về, sau đó JavaScript tạo nội dung |
| Thời gian tải trang ban đầu nhanh hơn | Thời gian tải trang ban đầu chậm hơn do phải tải JavaScript |
| SEO tốt hơn vì nội dung có sẵn trong HTML | SEO kém hơn vì nội dung được tạo sau khi tải JavaScript |
| Tốn tài nguyên server nhiều hơn | Giảm tải cho server, tăng tải cho client |
| Trải nghiệm chuyển trang kém mượt hơn | Trải nghiệm chuyển trang mượt mà hơn |
| Phù hợp với trang web nội dung tĩnh | Phù hợp với ứng dụng web động, tương tác nhiều |

> **Lưu ý**: Bài viết này chỉ giới thiệu sơ lược về SSR và CSR để làm nền tảng cho việc hiểu về phục vụ tài nguyên tĩnh và render template. Để tìm hiểu sâu hơn về các phương pháp rendering, các kỹ thuật hiện đại như hydration, streaming SSR, hay các framework như Next.js, Nuxt.js, hãy tham khảo các nguồn tài liệu chuyên sâu khác.

Trong bài viết này, chúng ta sẽ tập trung vào việc xây dựng các tính năng cơ bản để hỗ trợ server-side rendering trong framework Gee của chúng ta.

## 2. Phục vụ tài nguyên tĩnh

### 2.1. Tại sao cần phục vụ tài nguyên tĩnh?

Một trang web hoàn chỉnh không chỉ có HTML, mà còn cần nhiều loại tài nguyên khác như:
- CSS để định dạng giao diện
- JavaScript để tạo tương tác
- Hình ảnh, video, font chữ và các tệp đa phương tiện khác

Các tài nguyên này được gọi là "tĩnh" vì chúng không thay đổi theo mỗi request. Một framework web cần có khả năng phục vụ các tài nguyên này một cách hiệu quả.

### 2.2. Cách thức hoạt động

Khi người dùng truy cập một trang web, trình duyệt sẽ tự động gửi các request để tải các tài nguyên được tham chiếu trong HTML (như CSS, JavaScript, hình ảnh). Ví dụ, khi HTML có dòng:

```html
<link rel="stylesheet" href="/assets/css/style.css">
```

Trình duyệt sẽ gửi một request đến `/assets/css/style.css` để tải tệp CSS.

Framework của chúng ta cần:
1. Nhận request đến đường dẫn như `/assets/...`
2. Tìm tệp tương ứng trong hệ thống tệp của server
3. Trả về nội dung tệp với header phù hợp

### 2.3. Triển khai trong Gee

Để triển khai tính năng này, chúng ta sẽ tận dụng hai thành phần đã xây dựng trước đó:
1. **Định tuyến với wildcard**: Đã hỗ trợ trong phần 4 với pattern như `/*filepath`
2. **Thư viện chuẩn `http.FileServer`**: Go đã cung cấp sẵn công cụ để phục vụ tệp tĩnh

Dưới đây là luồng xử lý khi phục vụ tài nguyên tĩnh:

<div class="mermaid">
sequenceDiagram
    participant Client as Trình duyệt
    participant Router as Router Gee
    participant Handler as Static Handler
    participant FileSystem as Hệ thống tệp
    
    Client->>Router: GET /assets/css/style.css
    Router->>Router: Tìm route khớp với pattern
    Note over Router: Tìm thấy route "/assets/*filepath"
    Router->>Handler: Gọi handler với filepath="css/style.css"
    Handler->>FileSystem: Kiểm tra tệp "css/style.css" có tồn tại?
    FileSystem-->>Handler: Tệp tồn tại
    Handler->>FileSystem: Đọc nội dung tệp
    FileSystem-->>Handler: Trả về nội dung
    Handler->>Client: Phản hồi với nội dung tệp + Content-Type phù hợp
</div>

### 2.4. Mã nguồn triển khai

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

Giải thích mã nguồn:

1. `Static(relativePath, root)`: Phương thức này cho phép người dùng ánh xạ một thư mục vật lý (`root`) vào một đường dẫn URL (`relativePath`).

2. `createStaticHandler()`: Tạo một handler xử lý các request đến tài nguyên tĩnh:
   - `absolutePath`: Đường dẫn đầy đủ, kết hợp prefix của nhóm và đường dẫn tương đối
   - `http.StripPrefix()`: Loại bỏ phần prefix khỏi URL trước khi tìm tệp
   - `http.FileServer()`: Thành phần của Go để phục vụ tệp từ hệ thống tệp

3. Trong handler:
   - Trích xuất phần `filepath` từ URL (được định nghĩa bởi pattern `/*filepath`)
   - Kiểm tra xem tệp có tồn tại không
   - Nếu tồn tại, sử dụng `fileServer.ServeHTTP()` để phục vụ tệp

### 2.5. Cách sử dụng

```go
r := gee.New() 
r.Static("/assets", "./static")
r.Run(":9999")
```

Với cấu hình trên:
- Request đến `/assets/css/style.css` sẽ trả về nội dung của tệp `./static/css/style.css`
- Request đến `/assets/js/app.js` sẽ trả về nội dung của tệp `./static/js/app.js`
- Request đến `/assets/nonexistent.txt` sẽ trả về lỗi 404 nếu tệp không tồn tại

## 3. Render template HTML

### 3.1. Tại sao cần render template HTML?

Trong phát triển web, chúng ta thường cần tạo ra các trang HTML động - trang có cấu trúc cố định nhưng nội dung thay đổi dựa trên dữ liệu. Ví dụ:
- Trang hiển thị thông tin người dùng với tên, email khác nhau
- Trang danh sách sản phẩm với các sản phẩm khác nhau
- Trang blog với các bài viết khác nhau

Template HTML giúp chúng ta tách biệt cấu trúc HTML (phần không đổi) và dữ liệu (phần thay đổi), giúp code dễ bảo trì và mở rộng hơn.

### 3.2. Template trong Go

Go cung cấp hai thư viện template chuẩn:
- `text/template`: Thư viện cơ bản để xử lý template văn bản
- `html/template`: Mở rộng từ `text/template`, thêm các tính năng bảo mật cho HTML (như tự động escape để tránh XSS)

Thư viện `html/template` cung cấp nhiều tính năng mạnh mẽ:
- Hiển thị biến đơn giản
- Điều kiện rẽ nhánh (if-else)
- Vòng lặp (range)
- Gọi hàm tùy chỉnh
- Bao gồm template con
- Và nhiều tính năng khác

### 3.3.Triển khai trong Gee

Để hỗ trợ render template HTML trong Gee, chúng ta cần:
1. Thêm các trường cần thiết vào cấu trúc `Engine`
2. Cung cấp phương thức để tải template và đăng ký hàm tùy chỉnh
3. Cập nhật phương thức `HTML()` trong `Context` để render template

<div class="mermaid">
sequenceDiagram
    participant App as Ứng dụng
    participant Engine as Gee Engine
    participant Context as Context
    participant Template as html/template
    
    App->>Engine: LoadHTMLGlob("templates/*")
    Engine->>Template: Tải tất cả template
    App->>Engine: SetFuncMap(funcMap)
    Engine->>Template: Đăng ký các hàm tùy chỉnh
    
    App->>Context: c.HTML(200, "index.tmpl", data)
    Context->>Template: ExecuteTemplate("index.tmpl", data)
    Template->>Context: HTML đã render
    Context->>App: Phản hồi với HTML
</div>

**Giải thích biểu đồ:**

1. **Khởi tạo và cấu hình cho web app:**
   - Ứng dụng gọi `LoadHTMLGlob("templates/*")` để tải tất cả các template từ thư mục templates
   - Engine sẽ sử dụng `html/template` để tải và phân tích các template
   - Ứng dụng gọi `SetFuncMap(funcMap)` để đăng ký các hàm tùy chỉnh
   - Engine chuyển các hàm này cho `html/template` để sử dụng trong quá trình render

2. **Quá trình render:**
   - Khi xử lý request, ứng dụng gọi `c.HTML(200, "index.tmpl", data)` để render template
   - Context gọi `ExecuteTemplate("index.tmpl", data)` trên đối tượng template
   - Template engine xử lý template, thay thế biến và gọi các hàm tùy chỉnh
   - Kết quả HTML được trả về Context
   - Context gửi HTML đã render về cho ứng dụng, sau đó trả về cho client

Biểu đồ này minh họa rõ ràng luồng dữ liệu và trách nhiệm của từng thành phần trong quá trình render template HTML.

#### 3.3.1. Cập nhật cấu trúc Engine

```go
type Engine struct {
    *RouterGroup
    router        *router
    groups        []*RouterGroup     // lưu trữ tất cả các nhóm
    htmlTemplates *template.Template // cho render HTML
    funcMap       template.FuncMap   // cho render HTML
}
```

Chúng ta thêm hai trường mới:
- `htmlTemplates`: Lưu trữ tất cả các template đã tải
- `funcMap`: Lưu trữ các hàm tùy chỉnh có thể sử dụng trong template

#### 3.3.2. Phương thức để tải template và đăng ký hàm

```go
// Đăng ký các hàm tùy chỉnh cho template
func (engine *Engine) SetFuncMap(funcMap template.FuncMap) {
    engine.funcMap = funcMap
}

// Tải tất cả template từ một pattern (ví dụ: "templates/*")
func (engine *Engine) LoadHTMLGlob(pattern string) {
    engine.htmlTemplates = template.Must(template.New("").Funcs(engine.funcMap).ParseGlob(pattern))
}
```

- `SetFuncMap()`: Cho phép đăng ký các hàm tùy chỉnh để sử dụng trong template
- `LoadHTMLGlob()`: Tải tất cả các template từ một pattern (sử dụng `ParseGlob`)
- `template.Must()`: Hàm tiện ích của Go, gây panic nếu có lỗi khi tải template (giúp phát hiện lỗi sớm)

#### 3.3.3. Cập nhật Context để render template

```go
type Context struct {
    // Các trường hiện có...
    engine *Engine // Con trỏ đến engine để truy cập template
}

func (c *Context) HTML(code int, name string, data interface{}) {
    c.SetHeader("Content-Type", "text/html")
    c.Status(code)
    if err := c.engine.htmlTemplates.ExecuteTemplate(c.Writer, name, data); err != nil {
        c.Fail(500, err.Error())
    }
}
```

- Thêm trường `engine` vào `Context` để truy cập template
- Phương thức `HTML()` sử dụng `ExecuteTemplate()` để render template với tên cụ thể

#### 3.3.4. Cập nhật ServeHTTP để gán engine cho context

```go
func (engine *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    // ...
    c := newContext(w, req)
    c.handlers = middlewares
    c.engine = engine // Gán engine cho context
    engine.router.handle(c)
}
```

### 3.4. Các hàm tùy chỉnh (FuncMap) phổ biến

Go template cho phép đăng ký các hàm tùy chỉnh để mở rộng khả năng của template. Dưới đây là một số hàm tùy chỉnh phổ biến:

1. **Định dạng thời gian**:
```go
"FormatAsDate": func(t time.Time) string {
    year, month, day := t.Date()
    return fmt.Sprintf("%d-%02d-%02d", year, month, day)
}
```

2. **Chuyển đổi chuỗi sang chữ hoa/chữ thường**:
```go
"ToUpper": strings.ToUpper,
"ToLower": strings.ToLower
```

3. **Cắt chuỗi**:
```go
"Truncate": func(s string, length int) string {
    if len(s) <= length {
        return s
    }
    return s[:length] + "..."
}
```

4. **Tính toán đơn giản**:
```go
"Add": func(a, b int) int { return a + b },
"Subtract": func(a, b int) int { return a - b },
"Multiply": func(a, b int) int { return a * b },
"Divide": func(a, b int) int { 
    if b == 0 {
        return 0
    }
    return a / b 
}
```

5. **Kiểm tra điều kiện**:
```go
"IsEven": func(num int) bool { return num%2 == 0 },
"IsOdd": func(num int) bool { return num%2 != 0 }
```

### 3.5. Ví dụ sử dụng template và FuncMap

#### 3.5.1. Đăng ký FuncMap và tải template

```go
func main() {
    r := gee.New()
    
    // Đăng ký các hàm tùy chỉnh
    r.SetFuncMap(template.FuncMap{
        "FormatAsDate": func(t time.Time) string {
            year, month, day := t.Date()
            return fmt.Sprintf("%d-%02d-%02d", year, month, day)
        },
        "ToUpper": strings.ToUpper,
        "IsEven": func(num int) bool { return num%2 == 0 },
    })
    
    // Tải tất cả template từ thư mục templates
    r.LoadHTMLGlob("templates/*")
    
    // Cấu hình phục vụ tài nguyên tĩnh
    r.Static("/assets", "./static")
    
    // Các route...
}
```

#### 3.5.2 Ví dụ về template HTML

a. **Template hiển thị danh sách (arr.tmpl)**:
```html
<!-- templates/arr.tmpl -->
<html>
<head>
    <title>{{ .title }}</title>
    <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
    <h1>{{ .title | ToUpper }}</h1>
    <ul>
        {{range $index, $student := .stuArr}}
            <li class="{{if IsEven $index}}even{{else}}odd{{end}}">
                Tên: {{$student.Name}}, Tuổi: {{$student.Age}}
            </li>
        {{end}}
    </ul>
</body>
</html>
```

b. **Template sử dụng hàm định dạng thời gian (custom_func.tmpl)**:
```html
<!-- templates/custom_func.tmpl -->
<html>
<head>
    <title>{{ .title }}</title>
</head>
<body>
    <h1>{{ .title }}</h1>
    <p>Ngày hiện tại: {{ .now | FormatAsDate }}</p>
</body>
</html>
```

#### 3.5.3. Sử dụng template trong handler

```go
r.GET("/", func(c *gee.Context) {
    c.HTML(http.StatusOK, "css.tmpl", nil)
})

r.GET("/students", func(c *gee.Context) {
    students := []struct {
        Name string
        Age  int
    }{
        {"Alice", 20},
        {"Bob", 22},
        {"Charlie", 21},
        {"David", 23},
    }
    
    c.HTML(http.StatusOK, "arr.tmpl", gee.H{
        "title":  "Danh sách sinh viên",
        "stuArr": students,
    })
})

r.GET("/date", func(c *gee.Context) {
    c.HTML(http.StatusOK, "custom_func.tmpl", gee.H{
        "title": "Ngày tháng",
        "now":   time.Now(),
    })
})
```

#### 3.5.4. Kết quả hiển thị

Khi truy cập `/students`, trình duyệt sẽ hiển thị:

```
DANH SÁCH SINH VIÊN

• Tên: Alice, Tuổi: 20
• Tên: Bob, Tuổi: 22
• Tên: Charlie, Tuổi: 21
• Tên: David, Tuổi: 23
```

Khi truy cập `/date`, trình duyệt sẽ hiển thị:

```
Ngày tháng

Ngày hiện tại: 2023-05-25
```

## 4. Demo sử dụng
### Cấu trúc thư mục cuối cùng:

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

### Ví dụ về một template:

```html
<!-- templates/css.tmpl -->
<html>
    <link rel="stylesheet" href="/assets/css/geektutu.css">
    <p>geektutu.css đã được tải</p>
</html>
```

### Mã nguồn chính:

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
![Homepage demo](/img/gee-web/part-6/homepage_demo.png "Homepage demo")
Đây là một ví dụ hoàn chỉnh cho thấy cách Gee framework hỗ trợ cả phục vụ tài nguyên tĩnh và render template HTML.

Các route trong ví dụ này minh họa các tính năng khác nhau:
- `/`: Hiển thị template đơn giản với tài nguyên CSS tĩnh
- `/students`: Hiển thị danh sách đối tượng với vòng lặp và điều kiện
- `/date`: Sử dụng hàm tùy chỉnh để định dạng thời gian

## 5. Tổng kết

Trong phần thứ sáu này, chúng ta đã bổ sung cho framework Gee hai tính năng quan trọng:

1. **Phục vụ tài nguyên tĩnh**: Cho phép framework phục vụ các tệp tĩnh như CSS, JavaScript và hình ảnh.
2. **Render template HTML**: Hỗ trợ render template HTML với các biến động và hàm render tùy chỉnh.

Đến đây, Gee framework đã có những tính năng cơ bản của một web framework hiện đại:
- Xử lý HTTP request/response
- Định tuyến động với tham số
- Nhóm route và middleware
- Render template HTML
- Phục vụ tài nguyên tĩnh

Trong phần tiếp theo và cũng là phần cuối cùng của chuỗi bài viết, chúng ta sẽ tìm hiểu về cơ chế khôi phục từ lỗi (error recovery) - một tính năng quan trọng giúp ứng dụng web của chúng ta có khả năng chống chịu lỗi tốt hơn. Hy vọng chuỗi bài viết này đã mang lại cho bạn những kiến thức bổ ích và cảm hứng để tiếp tục khám phá thế giới phát triển web với Go!






