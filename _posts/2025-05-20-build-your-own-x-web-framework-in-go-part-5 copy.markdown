---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 4'
date: '2025-05-20 21:26'
excerpt: >-
  Phần 4 trong chuỗi bài về xây dựng web framework với Go. Trong bài này, chúng ta sẽ triển khai Route Group Control - một tính năng quan trọng giúp nhóm các route lại với nhau, hỗ trợ nhóm lồng nhau và tạo nền tảng cho việc áp dụng middleware.
comments: false
---

# Phần 4: Triển khai Route Group Control trong Gee Framework

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ tư trong loạt bài hướng dẫn xây dựng web framework Gee từ đầu bằng Go trong 7 ngày.

## Tại sao cần Route Group Control?

Route Group Control là một tính năng cơ bản mà mọi web framework cần có. Nó cho phép chúng ta nhóm các route có điểm chung lại với nhau, giúp quản lý code dễ dàng hơn. Trong thực tế, nhiều route thường cần xử lý tương tự nhau, ví dụ:

- Các route bắt đầu bằng `/post` cho phép truy cập ẩn danh
- Các route bắt đầu bằng `/admin` yêu cầu xác thực người dùng
- Các route bắt đầu bằng `/api` là các RESTful API cho bên thứ ba, cần xác thực riêng

Việc nhóm các route lại không chỉ giúp code gọn gàng hơn mà còn tạo nền tảng cho việc áp dụng middleware - một tính năng mạnh mẽ mà chúng ta sẽ tìm hiểu trong bài tiếp theo.

## Nhóm lồng nhau (Nested Groups)

Route Group thường được phân biệt bằng tiền tố (prefix) chung. Framework của chúng ta sẽ hỗ trợ:

- Phân nhóm theo tiền tố
- Hỗ trợ nhóm lồng nhau (nested groups)
- Middleware có thể áp dụng cho cả nhóm và nhóm con

Ví dụ về nhóm lồng nhau:
- `/post` là một nhóm
- `/post/a` và `/post/b` là các nhóm con của `/post`
- Middleware áp dụng cho nhóm `/post` sẽ tự động áp dụng cho các nhóm con
- Mỗi nhóm con vẫn có thể có middleware riêng

## Thiết kế cấu trúc Group

Một đối tượng Group cần có những thuộc tính sau:

```go
// RouterGroup là cấu trúc để quản lý các nhóm route
type RouterGroup struct {
    prefix      string           // tiền tố của nhóm route
    middlewares []HandlerFunc    // danh sách middleware của nhóm
    parent      *RouterGroup     // tham chiếu đến nhóm cha (hỗ trợ nhóm lồng nhau)
    engine      *Engine          // tham chiếu đến Engine chính
}
```

Chúng ta sẽ thiết kế `Engine` là nhóm cao nhất, kế thừa tất cả khả năng của `RouterGroup`:

```go
// Engine là cấu trúc chính của framework
type Engine struct {
    *RouterGroup            // Engine kế thừa các phương thức của RouterGroup
    router      *router     // bộ định tuyến
    groups      []*RouterGroup  // lưu trữ tất cả các nhóm
}
```

Với thiết kế này, chúng ta có thể triển khai tất cả các chức năng liên quan đến định tuyến trong `RouterGroup`. Dưới đây là cách triển khai:

```go
// Hàm khởi tạo Engine
func New() *Engine {
    engine := &Engine{router: newRouter()}
    engine.RouterGroup = &RouterGroup{engine: engine}
    engine.groups = []*RouterGroup{engine.RouterGroup}
    return engine
}

// Tạo nhóm mới từ nhóm hiện tại
func (group *RouterGroup) Group(prefix string) *RouterGroup {
    engine := group.engine
    newGroup := &RouterGroup{
        prefix: group.prefix + prefix,
        parent: group,
        engine: engine,
    }
    engine.groups = append(engine.groups, newGroup)
    return newGroup
}

// Thêm route vào nhóm
func (group *RouterGroup) addRoute(method string, comp string, handler HandlerFunc) {
    pattern := group.prefix + comp
    log.Printf("Route %4s - %s", method, pattern)
    group.engine.router.addRoute(method, pattern, handler)
}

// Định nghĩa phương thức GET
func (group *RouterGroup) GET(pattern string, handler HandlerFunc) {
    group.addRoute("GET", pattern, handler)
}

// Định nghĩa phương thức POST
func (group *RouterGroup) POST(pattern string, handler HandlerFunc) {
    group.addRoute("POST", pattern, handler)
}
```

Hãy chú ý đến hàm `addRoute`: nó gọi `group.engine.router.addRoute` để thực hiện việc ánh xạ route. Vì `Engine` kế thừa tất cả thuộc tính và phương thức của `RouterGroup`, nên `(*Engine).engine` trỏ đến chính nó. Với cách thiết kế này, chúng ta có thể thêm route như trước đây, hoặc thêm route theo nhóm.

## Cách sử dụng

```go
func main() {
    r := gee.New()

    // Route đơn lẻ
    r.GET("/index", func(c *gee.Context) {
        c.HTML(http.StatusOK, "<h1>Index Page</h1>")
    })

    // Nhóm v1
    v1 := r.Group("/v1")
    {
        v1.GET("/", func(c *gee.Context) {
            c.HTML(http.StatusOK, "<h1>Hello Gee</h1>")
        })

        v1.GET("/hello", func(c *gee.Context) {
            c.String(http.StatusOK, "hello %s, you're at %s\n",
                c.Query("name"), c.Path)
        })
    }

    // Nhóm v2
    v2 := r.Group("/v2")
    {
        v2.GET("/hello/:name", func(c *gee.Context) {
            c.String(http.StatusOK, "hello %s, you're at %s\n",
                c.Param("name"), c.Path)
        })

        v2.POST("/login", func(c *gee.Context) {
            c.JSON(http.StatusOK, gee.H{
                "username": c.PostForm("username"),
                "password": c.PostForm("password"),
            })
        })
    }

    r.Run(":9999")
}
```

## Kiểm thử

Sau khi triển khai xong, chúng ta có thể kiểm thử các route bằng `curl`:

```bash
# Kiểm tra route v1
$ curl "http://localhost:9999/v1/hello?name=geektutu"
hello geektutu, you're at /v1/hello

# Kiểm tra route v2
$ curl "http://localhost:9999/v2/hello/geektutu"
hello geektutu, you're at /v2/hello/geektutu
```

## Tổng kết

Với Route Group Control, chúng ta đã đạt được những lợi ích sau:

1. **Tổ chức code tốt hơn**: Nhóm các route có liên quan với nhau
2. **Dễ bảo trì**: Khi cần thay đổi logic cho một nhóm route, chỉ cần sửa ở một nơi
3. **Chuẩn bị cho middleware**: Tạo nền tảng để áp dụng middleware cho cả nhóm route
4. **Hỗ trợ nhóm lồng nhau**: Cho phép tổ chức route theo cấu trúc phân cấp

Trong bài tiếp theo (Phần 5), chúng ta sẽ tìm hiểu về middleware - một tính năng mạnh mẽ giúp thêm các chức năng mới cho framework mà không cần thay đổi cấu trúc chính của hệ thống.

