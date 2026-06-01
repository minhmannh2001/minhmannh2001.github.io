---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 7'
date: '2025-05-26 22:30'
excerpt: >-
  Bài cuối cùng trong chuỗi bài về xây dựng web framework với Go. Tìm hiểu cách triển khai cơ chế xử lý lỗi (error handling) để ngăn chặn ứng dụng bị crash khi xảy ra panic. Hoàn thiện framework Gee với khả năng phục hồi từ lỗi và cung cấp thông tin debug hữu ích.
comments: false
---

# Phần 7: Xử lý lỗi và phục hồi từ panic trong Gee Framework

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Bài viết này là phần thứ bảy (cũng là phần cuối cùng) trong chuỗi bài về việc xây dựng web framework Gee từ đầu bằng ngôn ngữ Go.

## Triển khai cơ chế xử lý lỗi

### panic

Trong Go, phương pháp xử lý lỗi phổ biến nhất là trả về một error, và người gọi (caller) sẽ quyết định cách xử lý sau đó. Đây là cách tiếp cận chính của Go đối với hầu hết các tình huống lỗi có thể xảy ra.
Tuy nhiên, đối với những lỗi nghiêm trọng không thể khôi phục, Go cung cấp cơ chế `panic`. Khi `panic` xảy ra, chương trình sẽ dừng thực thi ngay lập tức.

Có hai cách để `panic` xảy ra:
1. Chủ động gọi hàm `panic()`
2. Lỗi runtime như truy cập ngoài phạm vi mảng, chia cho 0, v.v.

Ví dụ về việc chủ động gọi `panic`:

```go
// hello.go
func main() {
    fmt.Println("before panic")
    panic("crash")
    fmt.Println("after panic") // dòng này không bao giờ được thực thi
}
```

Kết quả:

```
$ go run hello.go

before panic
panic: crash

goroutine 1 [running]:
main.main()
        ~/go_demo/hello/hello.go:7 +0x95
exit status 2
```

Ví dụ về `panic` do lỗi runtime:

```go
// hello.go
func main() {
    arr := []int{1, 2, 3}
    fmt.Println(arr[4]) // lỗi: index out of range
}
```

Kết quả:

```
$ go run hello.go
panic: runtime error: index out of range [4] with length 3
```

### defer

Khi `panic` xảy ra, chương trình sẽ dừng thực thi ngay lập tức, nhưng trước khi thoát hoàn toàn, Go sẽ thực thi tất cả các hàm đã được `defer` trong goroutine hiện tại. Đây là cơ chế quan trọng giúp chúng ta có thể dọn dẹp tài nguyên hoặc xử lý lỗi trước khi chương trình kết thúc.

```go
// hello.go
func main() {
    defer func() {
        fmt.Println("defer func được gọi")
    }()

    arr := []int{1, 2, 3}
    fmt.Println(arr[4])
}
```

Kết quả:

```
$ go run hello.go 
defer func được gọi
panic: runtime error: index out of range [4] with length 3
```

Bạn có thể thấy rằng mặc dù có lỗi, hàm `defer` vẫn được thực thi trước khi chương trình kết thúc. Nếu bạn defer nhiều tác vụ trong cùng một hàm, chúng sẽ được thực thi theo thứ tự ngược lại, nghĩa là tác vụ defer cuối cùng sẽ được thực thi đầu tiên.

### recover

Go cung cấp hàm `recover()` để "bắt" và xử lý `panic`. Hàm này chỉ có tác dụng khi được gọi trong một hàm `defer`. Khi `recover()` bắt được `panic`, chương trình sẽ tiếp tục thực thi bình thường thay vì kết thúc.

```go
// hello.go
func test_recover() {
    defer func() {
        fmt.Println("defer func được gọi")
        if err := recover(); err != nil {
            fmt.Println("đã recover thành công:", err)
        }
    }()

    arr := []int{1, 2, 3}
    fmt.Println(arr[4])
    fmt.Println("sau panic") // dòng này không được thực thi
}

func main() {
    test_recover()
    fmt.Println("sau recover") // dòng này được thực thi vì panic đã được xử lý
}
```

Kết quả:

```
$ go run hello.go 
defer func được gọi
đã recover thành công: runtime error: index out of range [4] with length 3
sau recover
```

Qua ví dụ trên, chúng ta thấy:
1. Khi `panic` xảy ra, luồng thực thi chuyển ngay đến hàm `defer`
2. Hàm `recover()` bắt được lỗi và chương trình tiếp tục thực thi
3. Dòng "sau panic" không được in ra vì nó nằm sau điểm `panic`
4. Dòng "sau recover" được in ra vì chương trình đã phục hồi và tiếp tục thực thi

## Cơ chế xử lý lỗi trong Gee

Đối với một web framework, việc xử lý lỗi là vô cùng quan trọng. Nếu không có cơ chế xử lý lỗi phù hợp, một lỗi nhỏ trong handler có thể làm crash toàn bộ server, khiến tất cả các request khác không được phục vụ.

Ví dụ, xem xét đoạn code sau:

```go
func main() {
    r := gee.New()
    r.GET("/panic", func(c *gee.Context) {
        names := []string{"geektutu"}
        c.String(http.StatusOK, names[100]) // lỗi: index out of range
    })
    r.Run(":9999")
}
```

Nếu người dùng truy cập `/panic`, handler sẽ gây ra lỗi khi cố gắng truy cập phần tử thứ 100 của mảng chỉ có 1 phần tử. Nếu không có cơ chế xử lý lỗi, server có thể bị crash.

> **Lưu ý quan trọng**: Thực tế, ngay cả khi không có middleware Recovery, thư viện chuẩn `net/http` của Go đã có cơ chế xử lý panic cơ bản, nên server không hoàn toàn bị crash. Tuy nhiên, request gây ra panic sẽ không nhận được phản hồi, và không có thông tin hữu ích nào được ghi lại để debug.

Để giải quyết vấn đề này, chúng ta sẽ triển khai một middleware `Recovery` đơn giản nhưng hiệu quả. Middleware này sẽ:
1. Bắt tất cả các panic xảy ra trong quá trình xử lý request
2. Ghi log chi tiết về lỗi và stack trace để dễ dàng debug
3. Trả về phản hồi "Internal Server Error" cho client thay vì để kết nối bị đóng

Chúng ta sẽ tận dụng cơ chế middleware đã triển khai trước đó để thêm tính năng xử lý lỗi vào framework Gee.

### Triển khai middleware Recovery

Thêm file mới `gee/recovery.go` với nội dung sau:

```go
func Recovery() HandlerFunc {
    return func(c *Context) {
        defer func() {
            if err := recover(); err != nil {
                message := fmt.Sprintf("%s", err)
                log.Printf("%s\n\n", trace(message))
                c.Fail(http.StatusInternalServerError, "Internal Server Error")
            }
        }()

        c.Next()
    }
}
```

Middleware `Recovery` hoạt động rất đơn giản:
1. Sử dụng `defer` để đảm bảo hàm phục hồi được gọi ngay cả khi có panic
2. Trong hàm defer, gọi `recover()` để bắt panic (nếu có)
3. Nếu có panic, ghi log thông tin lỗi và stack trace
4. Trả về mã lỗi 500 (Internal Server Error) cho client

Hàm `trace()` được sử dụng để lấy thông tin chi tiết về stack trace:

```go
// print stack trace for debug
func trace(message string) string {
    var pcs [32]uintptr
    n := runtime.Callers(3, pcs[:]) // bỏ qua 3 caller đầu tiên

    var str strings.Builder
    str.WriteString(message + "\nTraceback:")
    for _, pc := range pcs[:n] {
        fn := runtime.FuncForPC(pc)
        file, line := fn.FileLine(pc)
        str.WriteString(fmt.Sprintf("\n\t%s:%d", file, line))
    }
    return str.String()
}
```

Hàm `trace()` sử dụng các hàm từ package `runtime` để lấy thông tin về call stack:
1. `runtime.Callers(3, pcs[:])` lấy danh sách các program counter trong call stack, bỏ qua 3 caller đầu tiên (bản thân hàm Callers, hàm trace, và hàm defer)
2. Với mỗi program counter, lấy thông tin về hàm, file và số dòng tương ứng
3. Tạo chuỗi thông tin chi tiết về stack trace

Với middleware `Recovery` này, framework Gee của chúng ta đã có khả năng xử lý lỗi cơ bản, giúp server tiếp tục hoạt động ngay cả khi có panic xảy ra.

### Tích hợp Recovery vào Engine mặc định

Để thuận tiện cho người dùng, chúng ta thêm hàm `Default()` vào `gee.go` để tạo một Engine với các middleware cơ bản đã được cấu hình sẵn:

```go
// gee.go
// Default use Logger() & Recovery middlewares
func Default() *Engine {
    engine := New()
    engine.Use(Logger(), Recovery())
    return engine
}
```

Với hàm này, người dùng có thể dễ dàng tạo một Engine với middleware `Logger` và `Recovery` đã được cấu hình sẵn:

```go
r := gee.Default() // thay vì r := gee.New()
```

## Demo sử dụng

Hãy thử nghiệm middleware `Recovery` với một ví dụ đơn giản:

```go
package main

import (
    "net/http"

    "gee"
)

func main() {
    r := gee.Default() // sử dụng Engine với Logger và Recovery
    r.GET("/", func(c *gee.Context) {
        c.String(http.StatusOK, "Hello Geektutu\n")
    })
    // cố tình tạo lỗi để test Recovery
    r.GET("/panic", func(c *gee.Context) {
        names := []string{"geektutu"}
        c.String(http.StatusOK, names[100])
    })

    r.Run(":9999")
}
```

Khi chạy ứng dụng và thử nghiệm các endpoint:

```
$ curl "http://localhost:9999"
Hello Geektutu
$ curl "http://localhost:9999/panic"
{"message":"Internal Server Error"}
$ curl "http://localhost:9999"
Hello Geektutu
```

Chúng ta thấy rằng:
1. Endpoint `/` hoạt động bình thường
2. Khi truy cập `/panic`, mặc dù có lỗi nhưng server vẫn trả về phản hồi "Internal Server Error"
3. Sau khi xảy ra lỗi, server vẫn tiếp tục hoạt động bình thường, có thể phục vụ các request tiếp theo

Trong log của server, chúng ta sẽ thấy thông tin chi tiết về lỗi:

```
2020/01/09 01:00:10 Route  GET - /
2020/01/09 01:00:10 Route  GET - /panic
2020/01/09 01:00:22 [200] / in 25.364µs
2020/01/09 01:00:32 runtime error: index out of range
Traceback:
        /usr/local/Cellar/go/1.12.5/libexec/src/runtime/panic.go:523
        /usr/local/Cellar/go/1.12.5/libexec/src/runtime/panic.go:44
        /tmp/7days-golang/day7-panic-recover/main.go:47
        /tmp/7days-golang/day7-panic-recover/gee/context.go:41
        /tmp/7days-golang/day7-panic-recover/gee/recovery.go:37
        /tmp/7days-golang/day7-panic-recover/gee/context.go:41
        /tmp/7days-golang/day7-panic-recover/gee/logger.go:15
        /tmp/7days-golang/day7-panic-recover/gee/context.go:41
        /tmp/7days-golang/day7-panic-recover/gee/router.go:99
        /tmp/7days-golang/day7-panic-recover/gee/gee.go:130
        /usr/local/Cellar/go/1.12.5/libexec/src/net/http/server.go:2775
        /usr/local/Cellar/go/1.12.5/libexec/src/net/http/server.go:1879
        /usr/local/Cellar/go/1.12.5/libexec/src/runtime/asm_amd64.s:1338

2020/01/09 01:00:32 [500] /panic in 395.846µs
2020/01/09 01:00:38 [200] / in 6.985µs
```

Thông tin này rất hữu ích cho việc debug, giúp chúng ta dễ dàng xác định nguyên nhân và vị trí của lỗi.

## Giải thích về cơ chế xử lý panic trong Go web server

Có một điểm cần làm rõ: Ngay cả khi không có middleware `Recovery`, thư viện chuẩn `net/http` của Go đã có cơ chế xử lý panic cơ bản. Khi một panic xảy ra trong handler, Go sẽ bắt panic đó và đóng kết nối hiện tại, nhưng server vẫn tiếp tục chạy và phục vụ các request khác.

Tuy nhiên, có một số vấn đề với cơ chế mặc định này:
1. Client sẽ không nhận được phản hồi gì cả (kết nối bị đóng)
2. Không có thông tin hữu ích nào được ghi lại để debug

Middleware `Recovery` của chúng ta giải quyết các vấn đề này bằng cách:
1. Bắt panic và trả về phản hồi "Internal Server Error" cho client
2. Ghi log chi tiết về lỗi và stack trace
3. Cho phép server tiếp tục hoạt động bình thường

Đây là lý do tại sao hầu hết các web framework đều cung cấp middleware xử lý lỗi tương tự.

Biểu đồ dưới đây minh họa cách middleware Recovery hoạt động trong framework Gee:

```mermaid
sequenceDiagram
    participant Client as Client
    participant Server as HTTP Server
    participant Recovery as Recovery Middleware
    participant Handler as Route Handler
    
    Client->>Server: HTTP Request
    Server->>Recovery: Xử lý request
    
    Recovery->>Handler: c.Next()
    
    alt Không có lỗi
        Handler->>Recovery: Trả về kết quả bình thường
        Recovery->>Client: HTTP Response
    else Xảy ra panic
        Handler--xRecovery: panic!
        Note over Recovery: defer func() được gọi
        Recovery->>Recovery: recover()
        Recovery->>Recovery: log stack trace
        Recovery->>Client: 500 Internal Server Error
    end
    
    Note over Server: Server tiếp tục hoạt động
    Client->>Server: Request tiếp theo
```

**Giải thích biểu đồ:**

1. Client gửi HTTP request đến server
2. Server chuyển request đến middleware Recovery
3. Recovery gọi handler tiếp theo trong chuỗi middleware
4. Nếu handler xử lý bình thường:
   - Kết quả được trả về cho client
5. Nếu handler gây ra panic:
   - Hàm defer trong Recovery được kích hoạt
   - Recovery gọi recover() để bắt panic
   - Recovery ghi log thông tin lỗi và stack trace
   - Recovery trả về mã lỗi 500 cho client
6. Server vẫn tiếp tục hoạt động và có thể xử lý các request tiếp theo

## Tổng kết chuỗi bài viết

Qua 7 phần của chuỗi bài viết này, chúng ta đã xây dựng thành công một web framework đơn giản nhưng đầy đủ tính năng. Hãy nhìn lại những gì chúng ta đã học được:

### Phần 1: HTTP Handler cơ bản
- Tìm hiểu về interface `http.Handler` và cách Go xử lý HTTP request
- Xây dựng router đơn giản để định tuyến request đến các handler tương ứng

### Phần 2: Context
- Thiết kế struct `Context` để đóng gói thông tin request/response
- Cung cấp các phương thức tiện ích để xử lý request và trả về response

### Phần 3: Router động
- Triển khai trie tree để hỗ trợ các route động như `/user/:name`
- Xử lý các tham số trong URL và truyền chúng vào Context

### Phần 4: Nhóm route
- Tổ chức các route thành các nhóm để dễ quản lý
- Hỗ trợ các route lồng nhau và prefix chung

### Phần 5: Middleware
- Thiết kế cơ chế middleware để mở rộng chức năng của framework
- Triển khai middleware Logger để ghi log thông tin request

### Phần 6: Template
- Hỗ trợ render HTML template
- Phục vụ tài nguyên tĩnh như CSS, JavaScript, hình ảnh

### Phần 7: Xử lý lỗi
- Triển khai middleware Recovery để bắt và xử lý panic
- Ghi log thông tin lỗi chi tiết để dễ dàng debug

Framework Gee mà chúng ta đã xây dựng có thể không đủ mạnh mẽ để sử dụng trong môi trường production, nhưng nó đã thể hiện được những nguyên lý cốt lõi đằng sau các web framework phổ biến như Gin, Echo hay Fiber. Thông qua việc xây dựng Gee, chúng ta đã hiểu sâu hơn về cách một web framework hoạt động, và có thể áp dụng kiến thức này khi sử dụng các framework khác.

Hy vọng chuỗi bài viết này đã mang lại cho bạn những kiến thức bổ ích và cảm hứng để tiếp tục khám phá thế giới web development với Go!