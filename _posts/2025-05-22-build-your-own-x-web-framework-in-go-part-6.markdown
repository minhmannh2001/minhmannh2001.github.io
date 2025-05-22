---
layout: post
title: 'Build your own X: Tự xây dựng web framework với Go - Phần 5'
date: '2025-05-22 20:30'
excerpt: >-
  Phần 5 trong chuỗi bài về xây dựng web framework với Go. Bài viết này tập trung vào việc thiết kế và triển khai cơ chế middleware - thành phần quan trọng giúp mở rộng chức năng framework mà không cần sửa đổi mã nguồn gốc.
comments: false
---

# Phần 5: Triển khai cơ chế Middleware trong Gee Framework

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ năm trong loạt bài hướng dẫn xây dựng web framework Gee từ đầu bằng Go trong 7 ngày.

## Mục tiêu của bài viết này

- Thiết kế và triển khai cơ chế middleware cho web framework
- Xây dựng middleware Logger để theo dõi thời gian xử lý request

## Middleware là gì?

Middleware, hiểu một cách đơn giản, là các thành phần trung gian xử lý yêu cầu trước hoặc sau khi chúng đi qua logic nghiệp vụ chính. Chúng không đảm nhận nghiệp vụ cốt lõi, nhưng lại rất hữu ích để xử lý các tác vụ phổ biến như xác thực, ghi log, kiểm soát truy cập, hay xử lý lỗi.

Vì web framework không thể dự đoán hết mọi nhu cầu cụ thể của từng ứng dụng, nên nó cần cung cấp cơ chế cho phép người dùng tự định nghĩa và tích hợp thêm các chức năng này (middleware) một cách linh hoạt và liền mạch.

Khi thiết kế middleware, có hai yếu tố quan trọng cần cân nhắc:

1. **Điểm tích hợp**: Người dùng framework thường không quan tâm đến cách triển khai chi tiết bên trong. Nếu điểm tích hợp quá sâu trong framework, việc viết middleware sẽ trở nên phức tạp. Ngược lại, nếu điểm tích hợp quá gần với người dùng, middleware sẽ không mang lại nhiều lợi ích so với việc người dùng tự định nghĩa và gọi các hàm trong Handler.

2. **Dữ liệu đầu vào**: Dữ liệu được truyền vào middleware quyết định khả năng mở rộng của nó. Nếu framework cung cấp quá ít thông tin, người dùng sẽ bị giới hạn trong việc phát triển các tính năng mới.

Vậy middleware trong web framework nên được thiết kế như thế nào? Cách triển khai dưới đây lấy cảm hứng chủ yếu từ framework Gin.

## Thiết kế Middleware

Trong Gee, middleware được định nghĩa tương tự như Handler của route, với đầu vào là đối tượng `Context`. Điểm tích hợp được đặt ngay sau khi framework nhận request và khởi tạo đối tượng `Context`, cho phép người dùng thực hiện các xử lý bổ sung như ghi log và tùy chỉnh `Context`.

Đặc biệt, thông qua phương thức `(*Context).Next()`, middleware có thể chờ đợi cho đến khi Handler chính hoàn thành xử lý, sau đó thực hiện các thao tác bổ sung như tính toán thời gian xử lý. Nói cách khác, middleware trong Gee cho phép thực hiện các thao tác cả trước và sau khi request được xử lý.

Ví dụ, chúng ta có thể định nghĩa một middleware Logger như sau:

```go
func Logger() HandlerFunc {
    return func(c *Context) {
        // Bắt đầu đo thời gian
        t := time.Now()
        // Xử lý request
        c.Next()
        // Tính toán thời gian xử lý
        log.Printf("[%d] %s trong %v", c.StatusCode, c.Req.RequestURI, time.Since(t))
    }
}
```

Framework cũng hỗ trợ việc thiết lập nhiều middleware và gọi chúng theo thứ tự.

Trong bài viết trước về [Group Control](https://minhmannh2001.github.io/2025/05/19/build-your-own-x-web-framework-in-go-part-5.html), chúng ta đã đề cập rằng middleware được áp dụng cho `RouterGroup`. Khi áp dụng cho nhóm cấp cao nhất, middleware sẽ có tác động toàn cục, ảnh hưởng đến tất cả các request. Tại sao không áp dụng middleware cho từng route riêng lẻ? Bởi vì việc áp dụng middleware cho một route cụ thể không mang lại nhiều giá trị so với việc người dùng trực tiếp gọi các hàm trong Handler. Một chức năng chỉ áp dụng cho một route cụ thể thường không đủ tổng quát để được coi là middleware.

## Cơ chế hoạt động của Middleware

Trong thiết kế trước đây của framework, khi nhận được request, hệ thống sẽ tìm route phù hợp và lưu thông tin request trong `Context`. Tương tự, sau khi nhận request, tất cả middleware cần được áp dụng cho route đó sẽ được lưu trong `Context` và gọi theo thứ tự.

Tại sao cần lưu middleware trong `Context`? Bởi vì trong thiết kế của chúng ta, middleware không chỉ thực hiện các thao tác trước khi xử lý request, mà còn sau khi xử lý. Sau khi Handler chính hoàn thành, các thao tác còn lại trong middleware cần được thực thi.

Để làm được điều này, chúng ta bổ sung hai tham số vào `Context` và định nghĩa phương thức `Next`:

```go
type Context struct {
    // Đối tượng cơ bản của Go HTTP
    Writer http.ResponseWriter
    Req    *http.Request
    // Thông tin request
    Path   string
    Method string
    Params map[string]string
    // Thông tin response
    StatusCode int
    // Middleware
    handlers []HandlerFunc
    index    int
}

func newContext(w http.ResponseWriter, req *http.Request) *Context {
    return &Context{
        Path:   req.URL.Path,
        Method: req.Method,
        Req:    req,
        Writer: w,
        index:  -1,
    }
}

func (c *Context) Next() {
    c.index++
    s := len(c.handlers)
    for ; c.index < s; c.index++ {
        c.handlers[c.index](c)
    }
}
```

Biến `index` theo dõi middleware nào đang được thực thi. Khi phương thức `Next` được gọi, quyền điều khiển sẽ chuyển sang middleware tiếp theo cho đến khi tất cả middleware được gọi. Sau đó, theo thứ tự ngược lại, các đoạn code sau lệnh `c.Next()` trong mỗi middleware sẽ được thực thi. Điều gì xảy ra nếu chúng ta thêm Handler của route vào danh sách `c.handlers`? Bạn có thể đoán được.

Hãy xem ví dụ với hai middleware A và B:

```go
func A(c *Context) {
    // Phần 1
    c.Next()
    // Phần 2
}
func B(c *Context) {
    // Phần 3
    c.Next()
    // Phần 4
}
```

Giả sử chúng ta áp dụng middleware A, B và Handler của route. Khi đó `c.handlers` sẽ là [A, B, Handler], và `c.index` được khởi tạo với giá trị -1. Quá trình thực thi `c.Next()` diễn ra như sau:

1. `c.index++`, `c.index` trở thành 0
2. 0 < 3, gọi `c.handlers[0]`, tức là A
3. Thực thi Phần 1 và gọi `c.Next()`
4. `c.index++`, `c.index` trở thành 1
5. 1 < 3, gọi `c.handlers[1]`, tức là B
6. Thực thi Phần 3 và gọi `c.Next()`
7. `c.index++`, `c.index` trở thành 2
8. 2 < 3, gọi `c.handlers[2]`, tức là Handler
9. Sau khi Handler thực thi xong, quay lại Phần 4 trong B
10. Sau khi Phần 4 thực thi xong, quay lại Phần 2 trong A
11. Phần 2 hoàn thành và kết thúc quá trình

Nói cách khác, thứ tự thực thi là: Phần 1 → Phần 3 → Handler → Phần 4 → Phần 2. Cơ chế này đáp ứng đúng yêu cầu của middleware: có thể thực hiện các thao tác cả trước và sau khi xử lý request.

Dưới đây là sơ đồ minh họa quá trình thực thi middleware:

```mermaid
sequenceDiagram
    participant Client as Client
    participant Engine as Engine
    participant A as Middleware A
    participant B as Middleware B
    participant H as Handler
    
    Client->>Engine: HTTP Request
    Note over Engine: c.index = -1
    Note over Engine: c.handlers = [A, B, Handler]
    Engine->>A: c.Next() (index++ → 0)
    Note over A: Thực thi Phần 1
    A->>B: c.Next() (index++ → 1)
    Note over B: Thực thi Phần 3
    B->>H: c.Next() (index++ → 2)
    Note over H: Xử lý request
    H-->>B: Hoàn thành
    Note over B: Thực thi Phần 4
    B-->>A: Hoàn thành
    Note over A: Thực thi Phần 2
    A-->>Engine: Hoàn thành
    Engine-->>Client: HTTP Response
```

## Triển khai Code

Đầu tiên, chúng ta định nghĩa hàm `Use` để áp dụng middleware cho một Group:

```go
// Use thêm middleware vào nhóm
func (group *RouterGroup) Use(middlewares ...HandlerFunc) {
    group.middlewares = append(group.middlewares, middlewares...)
}

func (engine *Engine) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    var middlewares []HandlerFunc
    for _, group := range engine.groups {
        if strings.HasPrefix(req.URL.Path, group.prefix) {
            middlewares = append(middlewares, group.middlewares...)
        }
    }
    c := newContext(w, req)
    c.handlers = middlewares
    engine.router.handle(c)
}
```

Hàm `ServeHTTP` cũng được cập nhật. Khi nhận một request, chúng ta cần xác định middleware nào sẽ được áp dụng. Ở đây, chúng ta xác định dựa trên tiền tố URL. Sau khi thu thập danh sách middleware, chúng ta gán cho `c.handlers`.

Trong hàm `handle`, chúng ta thêm Handler tìm được từ route vào danh sách `c.handlers` và thực thi `c.Next()`:

```go
func (r *router) handle(c *Context) {
    n, params := r.getRoute(c.Method, c.Path)

    if n != nil {
        key := c.Method + "-" + n.pattern
        c.Params = params
        c.handlers = append(c.handlers, r.handlers[key])
    } else {
        c.handlers = append(c.handlers, func(c *Context) {
            c.String(http.StatusNotFound, "404 NOT FOUND: %s\n", c.Path)
        })
    }
    c.Next()
}
```

## Ví dụ sử dụng

Dưới đây là một ví dụ minh họa cách sử dụng middleware trong Gee:

```go
func onlyForV2() gee.HandlerFunc {
    return func(c *gee.Context) {
        // Bắt đầu đo thời gian
        t := time.Now()
        c.Next()
        // Tính toán thời gian xử lý
        log.Printf("[%d] %s trong %v cho nhóm v2", c.StatusCode, c.Req.RequestURI, time.Since(t))
    }
}

func main() {
    r := gee.New()
    r.Use(gee.Logger()) // Middleware toàn cục
    r.GET("/", func(c *gee.Context) {
        c.HTML(http.StatusOK, "<h1>Hello Gee</h1>")
    })

    v2 := r.Group("/v2")
    v2.Use(onlyForV2()) // Middleware cho nhóm v2
    {
        v2.GET("/hello/:name", func(c *gee.Context) {
            // expect /hello/geektutu
	c.String(http.StatusOK, "hello %s, you're at %s\n", c.Param("name"), c.Path)
        })
    }

    r.Run(":9999")
}
```

`gee.Logger()` là middleware mà chúng ta đã giới thiệu ở đầu bài. Chúng ta đặt nó như một middleware mặc định của framework. Trong ví dụ này, `gee.Logger()` được áp dụng toàn cục, ảnh hưởng đến tất cả các route. Trong khi đó, `onlyForV2()` chỉ được áp dụng cho nhóm `v2`.

Sử dụng curl để kiểm tra, chúng ta có thể thấy cả hai middleware đều hoạt động đúng:

```bash
$ curl http://localhost:9999/
>>> log
2019/08/17 01:37:38 [200] / trong 3.14µs

$ curl http://localhost:9999/v2/hello/geektutu
>>> log
2019/08/17 01:38:48 [200] /v2/hello/geektutu trong 61.467µs cho nhóm v2
2019/08/17 01:38:48 [200] /v2/hello/geektutu trong 281µs
```

## Tổng kết

Trong phần này, chúng ta đã:

1. Tìm hiểu về khái niệm và tầm quan trọng của middleware trong web framework
2. Thiết kế cơ chế middleware linh hoạt cho Gee framework
3. Triển khai middleware Logger để theo dõi thời gian xử lý request
4. Hỗ trợ middleware ở cấp độ toàn cục và cấp độ nhóm

Middleware là một tính năng mạnh mẽ, cho phép mở rộng chức năng của framework mà không cần sửa đổi mã nguồn gốc. Trong phần tiếp theo, chúng ta sẽ tìm hiểu về cách render template HTML - một tính năng quan trọng khác của web framework hiện đại.

