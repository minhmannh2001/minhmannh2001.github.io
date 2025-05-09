---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 1'
date: '2025-04-25 23:58'
excerpt: >-
  Bài đầu tiên trong chuỗi bài về việc xây dựng web framework với Go. Tìm hiểu về thư viện net/http, interface http.Handler và cách tạo một router đơn giản để xử lý các HTTP request. Bắt đầu hành trình tạo ra framework Gee từ những khái niệm cơ bản nhất.
comments: false
---

---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 1'
date: '2025-05-09 23:58'
excerpt: >-
  Giới thiệu chuỗi bài viết về cách xây dựng một web framework bằng Go, nhằm giúp bạn hiểu sâu hơn về cách hoạt động của một web framework – từ net/http cơ bản đến router, middleware và nhiều chức năng quan trọng khác của một web framework.
comments: false
---

# Ngày 1: Bắt đầu xây dựng Web Framework với Go - Giới thiệu http.Handler

Sau khi đọc và làm theo bài viết đầu tiên trong series "7 ngày xây dựng Web Framework bằng Go" từ blog geektutu.com, mình muốn chia sẻ lại những gì đã học được, kèm theo phần giải thích theo cách hiểu cá nhân, để giúp mọi người — đặc biệt là những ai mới tiếp cận với Golang — dễ hình dung và áp dụng hơn.

Ở ngày đầu tiên, tác giả tập trung vào những viên gạch đầu tiên để xây dựng một web framework: thư viện chuẩn net/http và interface http.Handler — thứ đứng sau hầu hết mọi web server viết bằng Go.

## 1. Khởi đầu đơn giản với net/http

Go đã trang bị sẵn thư viện net/http, cho phép chúng ta xây dựng một server web cực kỳ nhanh chóng chỉ với vài dòng code:

```go
func main() {
    http.HandleFunc("/", indexHandler)
    http.HandleFunc("/hello", helloHandler)
    log.Fatal(http.ListenAndServe(":9999", nil))
}

func indexHandler(w http.ResponseWriter, req *http.Request) {
    fmt.Fprintf(w, "URL.Path = %q\n", req.URL.Path)
}

func helloHandler(w http.ResponseWriter, req *http.Request) {
    for k, v := range req.Header {
        fmt.Fprintf(w, "Header[%q] = %q\n", k, v)
    }
}
```

Ở ví dụ trên, chúng ta định nghĩa hai route là `/` và `/hello`, mỗi route gắn với một handler tương ứng. Khi gọi curl đến các endpoint này, ta sẽ thấy kết quả hiển thị path hoặc header của request.

Điểm đáng chú ý: khi ListenAndServe được gọi, Go sẽ dùng một "Handler" mặc định để xử lý request — nhưng nếu muốn tự định nghĩa cách xử lý, ta cần hiểu rõ hơn về interface http.Handler.

## 2. Viết struct Engine để hiện thực hóa http.Handler

Go định nghĩa interface http.Handler rất đơn giản:

```go
type Handler interface {
    ServeHTTP(w http.ResponseWriter, r *http.Request)
}
```

Bất kỳ struct nào có phương thức ServeHTTP phù hợp sẽ tự động "trở thành" một handler, và có thể được truyền cho ListenAndServe.

Chúng ta thử tạo một struct Engine đơn giản như sau:

```go
type Engine struct{}

func (e *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    switch req.URL.Path {
    case "/":
        fmt.Fprintf(w, "URL.Path = %q\n", req.URL.Path)
    case "/hello":
        for k, v := range req.Header {
            fmt.Fprintf(w, "Header[%q] = %q\n", k, v)
        }
    default:
        fmt.Fprintf(w, "404 NOT FOUND: %s\n", req.URL)
    }
}
```

Sau đó, chỉ cần truyền instance Engine này vào ListenAndServe:

```go
func main() {
    engine := new(Engine)
    log.Fatal(http.ListenAndServe(":9999", engine))
}
```

Sau khi tạo struct Engine, chúng ta hiện thực phương thức ServeHTTP. Đây là phương thức có hai tham số:

- Tham số thứ hai là *http.Request, chứa toàn bộ thông tin của HTTP request như URL, header, body,...
- Tham số đầu tiên là http.ResponseWriter, cho phép chúng ta gửi phản hồi trở lại client.

Bây giờ, mọi request đều được định tuyến qua Engine của chúng ta — đây là bước đầu tiên để tạo ra một web framework: kiểm soát toàn bộ entrypoint của request.

## 3. Tạo prototype cho framework Gee

Tiếp theo, chúng ta refactor lại code một chút để tách phần định nghĩa framework ra một file riêng (gee.go), đồng thời định nghĩa cấu trúc framework như sau:

Tiếp theo, chúng ta bổ sung các phương thức Run, GET, POST, và bảng định tuyến router vào struct Engine. Bảng router này sẽ lưu trữ thông tin ánh xạ giữa method + path → handler.

```go
type HandlerFunc func(http.ResponseWriter, *http.Request)

type Engine struct {
    router map[string]HandlerFunc
}

func New() *Engine {
    return &Engine{router: make(map[string]HandlerFunc)}
}

func (e *Engine) addRoute(method, pattern string, handler HandlerFunc) {
    key := method + "-" + pattern
    e.router[key] = handler
}

func (e *Engine) GET(pattern string, handler HandlerFunc) {
    e.addRoute("GET", pattern, handler)
}

func (e *Engine) POST(pattern string, handler HandlerFunc) {
    e.addRoute("POST", pattern, handler)
}

func (e *Engine) Run(addr string) error {
    return http.ListenAndServe(addr, e)
}

func (e *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    key := req.Method + "-" + req.URL.Path
    if handler, ok := e.router[key]; ok {
        handler(w, req)
    } else {
        fmt.Fprintf(w, "404 NOT FOUND: %s\n", req.URL)
    }
}
```

Đây là phần nổi bật của tập tin gee.go. Chúng ta sẽ tập trung vào việc hiện thực logic này.

Trước tiên, chúng ta định nghĩa kiểu HandlerFunc, được cung cấp để người dùng framework sử dụng nhằm định nghĩa logic xử lý khi ánh xạ một route cụ thể. Trong struct Engine, chúng ta thêm một bảng định tuyến router, với key là sự kết hợp giữa phương thức HTTP và địa chỉ tĩnh của route, ví dụ như GET-/, GET-/hello, POST-/hello. Nhờ vậy, với cùng một route nhưng phương thức khác nhau, framework có thể ánh xạ tới các hàm xử lý khác nhau do người dùng định nghĩa.

Khi người dùng gọi phương thức (*Engine).GET(), framework sẽ đăng ký route và hàm xử lý tương ứng vào bảng định tuyến router. Còn phương thức (*Engine).Run() chỉ là một lớp bao cho hàm http.ListenAndServe.

Phương thức ServeHTTP của Engine sẽ phân tích đường dẫn trong request, tra cứu trong bảng định tuyến, và nếu tìm thấy thì gọi hàm xử lý tương ứng. Nếu không tìm thấy, framework sẽ trả về mã lỗi 404 NOT FOUND.

Với định nghĩa này, giờ đây ta có thể sử dụng framework của chính mình như sau trong main.go:

```go
func main() {
    r := gee.New()
    r.GET("/", func(w http.ResponseWriter, req *http.Request) {
        fmt.Fprintf(w, "URL.Path = %q\n", req.URL.Path)
    })
    r.GET("/hello", func(w http.ResponseWriter, req *http.Request) {
        for k, v := range req.Header {
            fmt.Fprintf(w, "Header[%q] = %q\n", k, v)
        }
    })
    r.Run(":9999")
}
```

Nếu bạn đã từng dùng qua Gin, chắc hẳn thấy giao diện này rất quen thuộc. Thực tế, Gee được viết với mục tiêu học hỏi từ Gin — một framework nhẹ, nhanh và rất phổ biến trong cộng đồng Go.

## Kết luận ngày 1

Tới đây, chúng ta đã hoàn thiện được một prototype cơ bản của framework Gee:

- Định nghĩa được type xử lý request (HandlerFunc)
- Xây dựng router lưu route theo method + path
- Tạo điểm entry point bằng cách hiện thực http.Handler
- Hỗ trợ định nghĩa route GET và POST một cách đơn giản

Mặc dù ở giai đoạn này framework của chúng ta chưa mạnh mẽ hơn so với net/http, nhưng đây là nền móng quan trọng để có thể tiếp tục mở rộng: thêm route động, middleware, template, và hơn thế nữa.

---

Bài viết tiếp theo (Ngày 2) sẽ tập trung vào việc thiết kế context để truyền thông tin qua middleware và handler — một phần không thể thiếu trong bất kỳ framework nào.