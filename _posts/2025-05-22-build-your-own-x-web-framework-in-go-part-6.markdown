---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 6'
date: '2025-05-25 20:30'
excerpt: >-
  Phần 6 trong chuỗi bài về xây dựng web framework với Go. Trong bài này, chúng ta sẽ thiết kế và triển khai cơ chế middleware - một thành phần quan trọng giúp mở rộng chức năng của framework mà không cần sửa đổi mã nguồn gốc.
comments: false
---

# Phần 6: Triển khai cơ chế Middleware trong Gee Framework

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ sáu trong loạt bài hướng dẫn xây dựng web framework Gee từ đầu bằng Go trong 7 ngày.

## Mục tiêu hôm nay

- Thiết kế và triển khai cơ chế middleware cho web framework
- Xây dựng middleware Logger để ghi lại thời gian xử lý từ khi nhận request đến khi trả response

## Middleware là gì?

Middleware, nói đơn giản, là các thành phần kỹ thuật phi nghiệp vụ. Bản thân web framework không thể hiểu hết mọi nghiệp vụ, và do đó không thể triển khai tất cả các chức năng. Vì vậy, framework cần một "ổ cắm" để cho phép người dùng tự định nghĩa các chức năng và nhúng chúng vào framework, như thể chức năng đó được framework hỗ trợ sẵn.

Khi thiết kế middleware, có hai điểm quan trọng cần xem xét:

1. **Điểm chèn (insertion point)**: Người dùng framework không quan tâm đến cách triển khai cụ thể của logic nền tảng. Nếu điểm chèn quá thấp, logic middleware sẽ rất phức tạp. Nếu điểm chèn quá gần với người dùng, sẽ không có nhiều lợi thế so với việc người dùng trực tiếp định nghĩa một tập hợp các hàm và gọi chúng thủ công trong Handler.

2. **Input của middleware**: Input của middleware quyết định khả năng mở rộng. Nếu quá ít tham số được tiết lộ, người dùng sẽ có không gian sáng tạo hạn chế.

Vậy đối với một web framework, middleware nên được thiết kế như thế nào? Cách triển khai sau đây chủ yếu dựa trên framework Gin.

## Thiết kế Middleware

Định nghĩa middleware của Gee nhất quán với Handler của route mapping, và input được xử lý là đối tượng `Context`. Điểm chèn là sau khi framework nhận request và khởi tạo đối tượng `Context`, cho phép người dùng sử dụng middleware tự định nghĩa để thực hiện một số xử lý bổ sung, như logging, v.v., và xử lý thứ cấp trên `Context`.

Ngoài ra, bằng cách gọi hàm `(*Context).Next()`, middleware có thể đợi cho đến khi Handler do người dùng định nghĩa hoàn thành xử lý, sau đó thực hiện một số thao tác bổ sung, chẳng hạn như tính toán thời gian sử dụng cho quá trình xử lý này. Nghĩa là, middleware của Gee hỗ trợ người dùng thực hiện một số thao tác bổ sung trước và sau khi request được xử lý.

Ví dụ, chúng ta hy vọng cuối cùng sẽ hỗ trợ middleware được định nghĩa như sau, trong đó `c.Next()` có nghĩa là đợi thực thi các middleware khác hoặc Handler của người dùng:

```go
func Logger() HandlerFunc {
    return func(c *Context) {
        // Start timer
        t := time.Now()
        // Process request
        c.Next()
        // Calculate resolution time
        log.Printf("[%d] %s in %v", c.StatusCode, c.Req.RequestURI, time.Since(t))
    }
}
```

Ngoài ra, framework hỗ trợ thiết lập nhiều middleware và gọi chúng theo thứ tự.

Trong bài viết trước về [Group Control](link-to-previous-article), chúng ta đã đề cập rằng middleware được áp dụng trên `RouterGroup`. Áp dụng nó cho Group cấp cao nhất tương đương với việc tác động ở cấp độ toàn cục, và tất cả các request sẽ được xử lý bởi middleware đó. Vậy tại sao không áp dụng nó cho từng quy tắc định tuyến? Áp dụng nó cho một quy tắc định tuyến nhất định không trực quan bằng việc người dùng gọi nó trực tiếp trong Handler. Chức năng chỉ áp dụng cho một quy tắc định tuyến nhất định quá kém về tính phổ quát và không phù hợp để được định nghĩa là middleware.

## Cách hoạt động của Middleware

Thiết kế framework trước đây của chúng ta như sau: khi nhận được request, route được khớp, và tất cả thông tin của request được lưu trong `Context`. Middleware cũng không ngoại lệ. Sau khi nhận request, tất cả middleware nên tác động lên route cần được tìm thấy, lưu trong `Context`, và gọi theo thứ tự.

Tại sao chúng ta cần lưu trong `Context` sau khi gọi theo thứ tự? Bởi vì trong thiết kế, middleware không chỉ hoạt động trước luồng xử lý, mà còn sau luồng xử lý, nghĩa là sau khi Handler do người dùng định nghĩa được xử lý, các thao tác còn lại có thể được thực thi.

Để làm điều này, chúng ta đã thêm hai tham số vào `Context` và định nghĩa phương thức `Next`:

```go
type Context struct {
    // origin objects
    Writer http.ResponseWriter
    Req    *http.Request
    // request info
    Path   string
    Method string
    Params map[string]string
    // response info
    StatusCode int
    // middleware
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

`index` ghi lại số middleware hiện đang được thực thi. Khi phương thức `Next` được gọi trong middleware, quyền điều khiển được chuyển cho middleware tiếp theo cho đến khi middleware cuối cùng được gọi. Sau đó, từ sau ra trước, phần được định nghĩa sau phương thức của mỗi middleware được gọi. Điều gì sẽ xảy ra nếu chúng ta thêm `Handler` của người dùng vào danh sách `c.handlers` khi ánh xạ route? Bạn hẳn đã đoán được.

```go
func A(c *Context) {
    part1
    c.Next()
    part2
}
func B(c *Context) {
    part3
    c.Next()
    part4
}
```

Giả sử chúng ta áp dụng middleware A và B, và handler của route mapping. `c.handlers` là [A, B, Handler], `c.index` được khởi tạo thành -1. Quá trình `c.Next()` như sau:

1. `c.index++`, `c.index` trở thành 0
2. 0 < 3, gọi `c.handlers[0]`, đó là A
3. Thực thi part1 và gọi `c.Next()`
4. `c.index++`, `c.index` trở thành 1
5. 1 < 3, gọi `c.handlers[1]`, đó là B
6. Thực thi part3 và gọi `c.Next()`
7. `c.index++`, `c.index` trở thành 2
8. 2 < 3, gọi `c.handlers[2]`, đó là Handler
9. Sau khi Handler được gọi, quay lại part4 trong B và thực thi part4
10. Sau khi part4 được thực thi, quay lại part2 trong A và thực thi part2
11. Part2 hoàn thành và kết thúc.

Nói đơn giản, thứ tự cuối cùng là part1 -> part3 -> Handler -> part4 -> part2: Điều này đáp ứng đúng yêu cầu của chúng ta đối với middleware.

## Triển khai Code

Định nghĩa hàm `Use` để áp dụng middleware cho một Group:

```go
// Use is defined to add middleware to the group
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

Hàm `ServeHTTP` cũng đã thay đổi. Khi nhận một request cụ thể, chúng ta cần xác định middleware nào request áp dụng. Ở đây, chúng ta đơn giản xác định bằng tiền tố URL. Sau khi lấy danh sách middleware, gán nó cho `c.handlers`.

Trong hàm `handle`, thêm Handler thu được từ route match vào danh sách `c.handlers` và thực thi `c.Next()`:

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

## Demo Sử dụng

```go
func onlyForV2() gee.HandlerFunc {
    return func(c *gee.Context) {
        // Start timer
        t := time.Now()
        // if a server error occurred
        c.Fail(500, "Internal Server Error")
        // Calculate resolution time
        log.Printf("[%d] %s in %v for group v2", c.StatusCode, c.Req.RequestURI, time.Since(t))
    }
}

func main() {
    r := gee.New()
    r.Use(gee.Logger()) // global midlleware
    r.GET("/", func(c *gee.Context) {
        c.HTML(http.StatusOK, "<h1>Hello Gee</h1>")
    })

    v2 := r.Group("/v2")
    v2.Use(onlyForV2()) // v2 group middleware
    {
        v2.GET("/hello/:name", func(c *gee.Context) {
            // expect /hello/geektutu
            c.String(http.StatusOK, "hello %s, you're at %s\n", c.Param("name"), c.Path)
        })
    }

    r.Run(":9999")
}
```

`gee.Logger()` là middleware mà chúng ta đã giới thiệu ở đầu bài. Chúng ta đặt middleware này cùng với mã framework như middleware mặc định được cung cấp bởi framework. Trong ví dụ này, chúng ta áp dụng `gee.Logger()` toàn cục, và tất cả các route sẽ áp dụng middleware này. `onlyForV2()` được sử dụng để kiểm tra chức năng và chỉ được áp dụng trong Group `v2` tương ứng.

Tiếp theo, sử dụng curl để kiểm tra và bạn có thể thấy cả hai middleware của Group v2 đều có hiệu lực:

```bash
$ curl http://localhost:9999/
>>> log
2019/08/17 01:37:38 [200] / in 3.14µs

(2) global + group middleware
$ curl http://localhost:9999/v2/hello/geektutu
>>> log
2019/08/17 01:38:48 [200] /v2/hello/geektutu in 61.467µs for group v2
2019/08/17 01:38:48 [200] /v2/hello/geektutu in 281µs
```

## Tổng kết

Trong phần này, chúng ta đã:

1. Hiểu được khái niệm và tầm quan trọng của middleware trong web framework
2. Thiết kế cơ chế middleware linh hoạt cho Gee framework
3. Triển khai middleware Logger để theo dõi thời gian xử lý request
4. Hỗ trợ middleware ở cấp độ toàn cục và cấp độ group

Middleware là một tính năng mạnh mẽ cho phép mở rộng chức năng của framework mà không cần sửa đổi mã nguồn gốc. Trong phần tiếp theo, chúng ta sẽ tìm hiểu về cách render template HTML - một tính năng quan trọng khác của web framework hiện đại.