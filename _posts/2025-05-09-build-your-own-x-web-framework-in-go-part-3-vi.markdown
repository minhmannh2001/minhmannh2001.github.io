---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 2'
date: '2025-05-09 23:58'
excerpt: >-
  Phần 2 trong chuỗi bài về xây dựng web framework với Go. Tìm hiểu về thiết kế Context để đóng gói thông tin request/response, cung cấp các phương thức tiện ích để trả về dữ liệu dạng HTML, JSON, và tổ chức lại cấu trúc code để dễ mở rộng.
comments: false
---

# Phần 2: Thiết kế Context trong Web Framework Gee

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ hai trong loạt bài hướng dẫn xây dựng web framework Gee bằng ngôn ngữ Go trong 7 ngày.

## Mục tiêu hôm nay

- Tách riêng module router để dễ mở rộng sau này
- Thiết kế một cấu trúc Context để đóng gói các thông tin về request/response
- Hỗ trợ trả dữ liệu dạng html, json, string, v.v...

Tính đến hết phần 2 này, toàn bộ framework có khoảng 140 dòng code, trong đó khoảng 90 dòng được thêm mới hôm nay.

## Kết quả

Ví dụ sử dụng sau khi hoàn thành:

```go
func main() {
    r := gee.New()
    r.GET("/", func(c *gee.Context) {
        c.HTML(http.StatusOK, "<h1>Hello Gee</h1>")
    })
    r.GET("/hello", func(c *gee.Context) {
        c.String(http.StatusOK, "hello %s, you're at %s\n", c.Query("name"), c.Path)
    })
    r.POST("/login", func(c *gee.Context) {
        c.JSON(http.StatusOK, gee.H{
            "username": c.PostForm("username"),
            "password": c.PostForm("password"),
        })
    })
    r.Run(":9999")
}
```

### Điểm đáng chú ý:

- Tham số truyền vào các handler bây giờ là `*gee.Context`, giúp truy cập dễ dàng đến các thông tin trong query, post form,...
- Context cung cấp các hàm tiện ích như HTML, JSON, String để tạo phản hồi dễ dàng.

## Tại sao cần Context?

Trong dịch vụ web, việc xử lý thường xoay quanh hai đối tượng:

- `*http.Request`: chứa thông tin request (url, header, body,...)
- `http.ResponseWriter`: để gửi phản hồi về cho client

Tuy nhiên, sử dụng trực tiếp hai đối tượng này khá rườm rà. Ví dụ để trả về json:

```go
obj := map[string]interface{}{"name": "geektutu", "password": "1234"}
w.Header().Set("Content-Type", "application/json")
w.WriteHeader(http.StatusOK)
encoder := json.NewEncoder(w)
if err := encoder.Encode(obj); err != nil {
    http.Error(w, err.Error(), 500)
}
```

Sau khi có Context, chỉ cần:

```go
c.JSON(http.StatusOK, gee.H{
    "username": c.PostForm("username"),
    "password": c.PostForm("password"),
})
```

Không chỉ giúp rút gọn code, Context còn là nơi lưu trữ mọi thứ liên quan đến request hiện tại: params từ router, dữ liệu của middleware,... Nó hoạt động như một kho chứa trung tâm, lưu trữ và quản lý toàn bộ thông tin liên quan đến một phiên xử lý HTTP.

## Cấu trúc Context

File: [part-2-context/gee/context.go](https://github.com/minhmannh2001/7-days-golang/blob/master/gee-web/part-2-context/gee/context.go)

File này định nghĩa một kiểu dữ liệu quan trọng: Context — nơi tập trung toàn bộ thông tin liên quan đến request hiện tại.

### Khai báo và cấu trúc:

```go
type H map[string]interface{}
```

Hàm alias cho kiểu `map[string]interface{}` để viết gọn hơn khi tạo JSON, ví dụ: `gee.H{"name": "geektutu"}`.

```go
type Context struct {
    // Các đối tượng gốc
    Writer http.ResponseWriter
    Req    *http.Request

    // Thông tin request thường dùng
    Path   string
    Method string

    // Thông tin phản hồi
    StatusCode int
}
```

Context hiện tại chỉ chứa `http.ResponseWriter` và `*http.Request`, hai đối tượng cốt lõi khi làm việc với HTTP trong Go.

Đồng thời cung cấp luôn các thuộc tính Path và Method để truy cập nhanh.

StatusCode được lưu lại để phục vụ logging/middleware sau này.

### Hàm khởi tạo Context

```go
func newContext(w http.ResponseWriter, req *http.Request) *Context {
    return &Context{
        Writer: w,
        Req:    req,
        Path:   req.URL.Path,
        Method: req.Method,
    }
}
```

Khởi tạo Context mới từ `http.ResponseWriter` và `*http.Request`. Gán Path và Method ngay để thuận tiện truy cập.

### Truy xuất dữ liệu từ Request

```go
func (c *Context) PostForm(key string) string {
    return c.Req.FormValue(key)
}
```

Trả về giá trị của key từ body của POST form.

```go
func (c *Context) Query(key string) string {
    return c.Req.URL.Query().Get(key)
}
```

Trả về giá trị của key trong query string (ví dụ: `/hello?name=manh` → `c.Query("name")` sẽ trả về "manh").

### Thiết lập Status Code và Header

```go
func (c *Context) Status(code int) {
    c.StatusCode = code
    c.Writer.WriteHeader(code)
}
```

Ghi lại mã status trả về và gửi tới client.

```go
func (c *Context) SetHeader(key string, value string) {
    c.Writer.Header().Set(key, value)
}
```

Thiết lập một header HTTP, như Content-Type, Authorization,...

### Trả về phản hồi (Response)

Trả chuỗi văn bản thuần (string):

```go
func (c *Context) String(code int, format string, values ...interface{}) {
    c.SetHeader("Content-Type", "text/plain")
    c.Status(code)
    c.Writer.Write([]byte(fmt.Sprintf(format, values...)))
}
```

Ví dụ: `c.String(200, "hello %s", "Gee")` → "hello Gee"

Trả JSON:

```go
func (c *Context) JSON(code int, obj interface{}) {
    c.SetHeader("Content-Type", "application/json")
    c.Status(code)
    encoder := json.NewEncoder(c.Writer)
    if err := encoder.Encode(obj); err != nil {
        http.Error(c.Writer, err.Error(), 500)
    }
}
```

Tự động mã hóa đối tượng obj thành JSON và gửi về client.

Trả dữ liệu thô (binary):

```go
func (c *Context) Data(code int, data []byte) {
    c.Status(code)
    c.Writer.Write(data)
}
```

Phù hợp khi gửi file, hình ảnh,...

Trả nội dung HTML:

```go
func (c *Context) HTML(code int, html string) {
    c.SetHeader("Content-Type", "text/html")
    c.Status(code)
    c.Writer.Write([]byte(html))
}
```

Ví dụ: `c.HTML(200, "<h1>Hello</h1>")` → Trình duyệt sẽ hiển thị HTML.

Tóm lại: Context giúp gom toàn bộ thao tác liên quan đến một request — từ truy xuất input đến trả output — vào một nơi duy nhất. Điều này làm cho code ở handler gọn gàng, dễ đọc và dễ mở rộng hơn.

## Tách riêng router

File: [part-2-context/gee/router.go](https://github.com/minhmannh2001/7-days-golang/blob/master/gee-web/part-2-context/gee/router.go)

```go
type router struct {
    handlers map[string]HandlerFunc
}

func newRouter() *router {
    return &router{handlers: make(map[string]HandlerFunc)}
}

func (r *router) addRoute(method string, pattern string, handler HandlerFunc) {
    log.Printf("Route %4s - %s", method, pattern)
    key := method + "-" + pattern
    r.handlers[key] = handler
}

func (r *router) handle(c *Context) {
    key := c.Method + "-" + c.Path
    if handler, ok := r.handlers[key]; ok {
        handler(c)
    } else {
        c.String(http.StatusNotFound, "404 NOT FOUND: %s\n", c.Path)
    }
}
```

Chúng ta đã tách các cấu trúc và phương thức liên quan đến định tuyến (routing) ra một file riêng là router.go, thay vì để chung trong engine như trước. Việc tách này giúp tổ chức mã nguồn rõ ràng hơn và tạo điều kiện thuận lợi để mở rộng tính năng router sau này, ví dụ như hỗ trợ định tuyến động (dynamic routing với tham số :name, *filepath,...).

Bên cạnh đó, phương thức handle trong router cũng được điều chỉnh nhẹ: thay vì nhận vào đối tượng http.ResponseWriter và *http.Request, handler giờ đây nhận một con trỏ đến Context. Nhờ đó, trong mỗi handler, ta có thể sử dụng các tiện ích đã định nghĩa trong Context như lấy dữ liệu từ query, post form, trả về JSON, v.v., giúp việc viết route handler trở nên ngắn gọn và tiện lợi hơn.

## Entry point framework

File: [part-2-context/gee/gee.go](https://github.com/minhmannh2001/7-days-golang/blob/master/gee-web/part-2-context/gee/gee.go)

```go
type HandlerFunc func(*Context)

type Engine struct {
    router *router
}

func New() *Engine {
    return &Engine{router: newRouter()}
}

func (engine *Engine) addRoute(method string, pattern string, handler HandlerFunc) {
    engine.router.addRoute(method, pattern, handler)
}

func (engine *Engine) GET(pattern string, handler HandlerFunc) {
    engine.addRoute("GET", pattern, handler)
}

func (engine *Engine) POST(pattern string, handler HandlerFunc) {
    engine.addRoute("POST", pattern, handler)
}

func (engine *Engine) Run(addr string) error {
    return http.ListenAndServe(addr, engine)
}

func (engine *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    c := newContext(w, req)
    engine.router.handle(c)
}
```

Hiện tại framework vẫn còn đơn giản nhưng đã đủ khả năng xử lý request và route. Việc xây dựng Context giúp việc phát triển sau này thuận tiện hơn.

Sau khi tách riêng các đoạn mã nguồn liên quan đến router vào file router.go, cấu trúc của file gee.go trở nên đơn giản hơn rất nhiều.

So với phiên bản ở ngày đầu tiên, phương thức ServeHTTP cũng đã được chỉnh sửa một chút: trước khi gọi router.handle, ta khởi tạo một đối tượng Context mới và truyền vào. Đối tượng Context này hiện vẫn còn đơn giản, chỉ bao bọc hai tham số ban đầu là http.ResponseWriter và *http.Request, nhưng về sau nó sẽ dần được mở rộng với nhiều tiện ích mạnh mẽ hơn.

Việc sử dụng framework vẫn giống như trong phần main.go đã trình bày ở đầu bài. Sau khi chạy chương trình với lệnh:

```bash
go run main.go
```

Ta có thể thử các lệnh curl sau để kiểm tra kết quả:

```bash
$ curl -i http://localhost:9999/
HTTP/1.1 200 OK
Date: Mon, 12 Aug 2019 16:52:52 GMT
Content-Length: 18
Content-Type: text/html; charset=utf-8

<h1>Hello Gee</h1>

$ curl "http://localhost:9999/hello?name=geektutu"
hello geektutu, you're at /hello

$ curl "http://localhost:9999/login" -X POST -d 'username=geektutu&password=1234'
{"password":"1234","username":"geektutu"}

$ curl "http://localhost:9999/xxx"
404 NOT FOUND: /xxx
```

Như vậy, các tính năng cơ bản như routing GET/POST, lấy tham số từ query hoặc form, và trả về JSON đã hoạt động tốt. Đồng thời, các route không được định nghĩa cũng được xử lý hợp lý với thông báo lỗi 404.

## Kết luận phần 2

Trong phần thứ 2, chúng ta đã tạo ra một cấu trúc Context để đóng gói thông tin request/response và cung cấp các phương thức tiện ích. Điều này giúp đơn giản hóa việc viết handler và tạo nền tảng cho các tính năng phức tạp hơn sau này.

Chúng ta cũng đã tổ chức lại cấu trúc code, tách riêng phần router để dễ dàng mở rộng trong tương lai. Framework Gee đã bắt đầu có hình dáng của một web framework thực thụ, với khả năng xử lý các loại request và response khác nhau một cách linh hoạt.

---

Bài viết tiếp theo (Phần 3) sẽ tập trung vào việc triển khai router động với cấu trúc dữ liệu Trie, cho phép định nghĩa các route với tham số động như `:name` và `*filepath`.