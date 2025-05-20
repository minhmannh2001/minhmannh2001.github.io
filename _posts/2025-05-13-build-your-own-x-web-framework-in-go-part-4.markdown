---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Phần 3'
date: '2025-05-09 23:58'
excerpt: >-
  Phần 3 trong chuỗi bài về xây dựng web framework với Go. Trong bài này, chúng ta sẽ học cách triển khai định tuyến động (dynamic routing) bằng cây tiền tố (Trie tree) thay vì sử dụng map như trước đây.
comments: false
---

# Phần 3: Định Tuyến Router bằng Cây Tiền Tố (Prefix Tree)

👉 [Mã nguồn đầy đủ trên GitHub](https://github.com/minhmannh2001/7-days-golang)

Đây là bài viết thứ ba trong loạt bài hướng dẫn xây dựng web framework Gee từ đầu bằng Go trong 7 ngày. Trong bài này, chúng ta sẽ học cách triển khai định tuyến động (dynamic routing) bằng cây tiền tố (Trie tree) thay vì sử dụng map như trước đây.

## Mục tiêu hôm nay

- Tìm hiểu khái niệm **dynamic routing** trong web framework

- Giới thiệu và áp dụng **cây Trie (prefix tree)**

- Hỗ trợ hai kiểu đối số trong đường dẫn: `:name` và `*filepath`

## 1. Định Tuyến Động (Dynamic Routing) là gì?

Trước đây, chúng ta dùng `map[string]HandlerFunc` để lưu trữ bảng định tuyến, nhưng cách này chỉ hợp với đường dẫn tĩnh. Ví dụ:

```go
r.GET("/hello/geektutu", handler)
```

Nhưng nếu ta muốn khớp bất kỳ tên người dùng nào với đường dẫn có định dạng như /hello/:name, thì `map[string]HandlerFunc` không đủ linh hoạt. **Dynamic routing** cho phép ta định nghĩa đường dẫn với biến:

```go
r.GET("/hello/:name", handler)
```

Trong trường hợp này, /hello/geektutu hay /hello/manh đều khớp với route trên.
Nếu chỉ dùng `map[string]HandlerFunc`, ta không thể khởi tạo một map với tập key là danh sách chứa tất cả các giá trị cho trường name

## 2. Trie Tree là gì?
![Trie](/img/gee-web/part-4/trie-introduction.jpg "Trie tree")

`Trie (prefix tree)` là cấu trúc cây được thiết kế để tối ưu việc tìm kiếm chuỗi với tiền tố chung. Đối với định tuyến web, mỗi định tuyến URL như /p/:lang/doc được chia thành các phân đoạn (segment) như p, :lang, doc. Mỗi node trong cây Trie sẽ tương ứng với một segment.

Ví dụ:

```
/:lang/doc
/:lang/tutorial
/:lang/intro
/about
/p/blog
/p/related
```

Ta xây dựng cây Trie từ ví dụ bên trên, trong đó mỗi node là một phần của đường dẫn.
![Trie router](/img/gee-web/part-4/trie_router.jpg "Trie router")

Khi truy vấn, di chuyển xuống theo cây. Nếu không tìm thấy node khớp, routing thất bại.

#### Ví dụ về quá trình tìm kiếm trong cây Trie

Hãy xem xét cách định tuyến thông qua cây trie bên trên thông qua các ví dụ cụ thể:

##### Đường dẫn tĩnh (Static Path)

| Truy vấn | Quá trình tìm kiếm | Kết quả |
|----------|-------------------|---------|
| `/about` | root `/` → node `about` | ✅ Thành công |
| `/p/blog` | root `/` → node `p` → node `blog` | ✅ Thành công |
| `/p/contact` | root `/` → node `p` → không tìm thấy node `contact` | ❌ Thất bại |

##### Đường dẫn động (Dynamic Path)

| Truy vấn | Quá trình tìm kiếm | Kết quả |
|----------|-------------------|---------|
| `/en/doc` | root `/` → khớp `:lang` với giá trị `en` → node `doc` | ✅ Thành công |
| `/vi/tutorial` | root `/` → khớp `:lang` với giá trị `vi` → node `tutorial` | ✅ Thành công |
| `/jp/introduction` | root `/` → khớp `:lang` với giá trị `jp` → không tìm thấy node `introduction` | ❌ Thất bại |

## 3. Xây dựng Cây Trie - Trái tim của Router động

Trong phần này, chúng ta sẽ xây dựng một cấu trúc dữ liệu đặc biệt gọi là **cây Trie** (hay cây tiền tố) để giải quyết bài toán định tuyến động. Đây là một bước tiến quan trọng so với cách dùng map đơn giản ở các phần trước.

### Thiết kế Node trong cây Trie

Mỗi node trong cây Trie của chúng ta sẽ lưu trữ những thông tin sau:

```go
type node struct {
    pattern  string  // Đường dẫn đầy đủ, ví dụ: /p/:lang/doc
    part     string  // Một phần của URL, ví dụ: p, :lang, doc
    children []*node // Các node con
    isWild   bool    // Đánh dấu node động (chứa : hoặc *)
}
```

Hãy hiểu rõ từng trường:

- **pattern**: Chỉ có giá trị ở node lá (node cuối cùng của một route). Ví dụ, với route `/p/:lang/doc`, chỉ node `doc` mới có `pattern = "/p/:lang/doc"`, các node trung gian sẽ có `pattern = ""`.

- **part**: Một mảnh nhỏ của URL. Ví dụ, URL `/p/:lang/doc` sẽ được chia thành 3 phần: `p`, `:lang`, và `doc`.

- **isWild**: Cờ đánh dấu node động - những node có thể khớp với nhiều giá trị khác nhau. Nếu part bắt đầu bằng `:` hoặc `*`, node đó là node động.

### Cách cây Trie hoạt động

Khác với cây thông thường, cây Trie của chúng ta có khả năng **khớp mờ** nhờ vào tham số `isWild`. Ví dụ:

- Khi một request đến `/p/golang/doc`:
  - Node đầu tiên `p` khớp chính xác
  - Node thứ hai `:lang` khớp mờ với `golang` (vì nó là node động)
  - Node thứ ba `doc` khớp chính xác
  - Kết quả: Tìm thấy route và `lang = "golang"`

Để thực hiện việc khớp, chúng ta cần hai hàm hỗ trợ:

```go
// Trả về node con đầu tiên khớp thành công, dùng cho việc thêm node vào trie
func (n *node) matchChild(part string) *node {
    for _, child := range n.children {
        if child.part == part || child.isWild {
            return child
        }
    }
    return nil
}

// Trả về tất cả các node con khớp thành công, dùng cho việc tìm kiếm
func (n *node) matchChildren(part string) []*node {
    nodes := make([]*node, 0)
    for _, child := range n.children {
        if child.part == part || child.isWild {
            nodes = append(nodes, child)
        }
    }
    return nodes
}
```

### Thêm và tìm kiếm route trong cây Trie

Hai hoạt động chính của router là:
1. **Đăng ký route**: Thêm route mới vào cây Trie
2. **Khớp route**: Tìm handler phù hợp với URL request

#### Hàm thêm route (insert)

```go
func (n *node) insert(pattern string, parts []string, height int) {
    // Nếu đã duyệt hết các phần của URL, đánh dấu đây là node lá
    if len(parts) == height {
        n.pattern = pattern
        return
    }

    // Lấy phần hiện tại cần xử lý
    part := parts[height]
    
    // Tìm node con phù hợp
    child := n.matchChild(part)
    
    // Nếu không có node con phù hợp, tạo node mới
    if child == nil {
        child = &node{
            part: part, 
            isWild: part[0] == ':' || part[0] == '*'
        }
        n.children = append(n.children, child)
    }
    
    // Đệ quy xuống tầng tiếp theo
    child.insert(pattern, parts, height+1)
}
```

Hàm này hoạt động theo nguyên tắc đệ quy, xây dựng cây từ trên xuống dưới. Điểm quan trọng là chỉ node lá (node cuối cùng) mới được gán giá trị `pattern`.

#### Hàm tìm kiếm route (search)

```go
func (n *node) search(parts []string, height int) *node {
    // Điều kiện dừng: đã duyệt hết URL hoặc gặp wildcard *
    if len(parts) == height || strings.HasPrefix(n.part, "*") {
        // Nếu node hiện tại không phải node lá, trả về nil
        if n.pattern == "" {
            return nil
        }
        return n
    }

    // Lấy phần hiện tại cần xử lý
    part := parts[height]
    
    // Tìm tất cả node con có thể khớp
    children := n.matchChildren(part)

    // Duyệt qua từng node con và tìm kiếm đệ quy
    for _, child := range children {
        result := child.search(parts, height+1)
        if result != nil {
            return result
        }
    }

    return nil
}
```

Hàm search cũng hoạt động đệ quy, nhưng phức tạp hơn vì cần xử lý các trường hợp khớp mờ. Nó sẽ dừng khi:
- Đã duyệt hết các phần của URL
- Gặp wildcard `*` (khớp tất cả phần còn lại)
- Không tìm thấy node con phù hợp

### Ví dụ trực quan

Giả sử chúng ta đã đăng ký các route sau:
```
/
/hello/:name
/hello/b/c
/hi/:name
/assets/*filepath
```

Cây Trie sẽ có dạng:

```
root
├── / (pattern="/")
├── hello
│   ├── :name (pattern="/hello/:name")
│   └── b
│       └── c (pattern="/hello/b/c")
├── hi
│   └── :name (pattern="/hi/:name")
└── assets
    └── *filepath (pattern="/assets/*filepath")
```

Khi một request đến `/hello/geektutu`:
1. Bắt đầu từ root, tìm node con "hello" → Tìm thấy
2. Từ node "hello", tìm node con khớp với "geektutu" → Tìm thấy node ":name" (khớp mờ)
3. Đã duyệt hết URL, kiểm tra node ":name" có phải node lá không → Đúng (pattern="/hello/:name")
4. Kết quả: Tìm thấy route "/hello/:name" với params["name"] = "geektutu"

Đây chính là cách cây Trie giúp chúng ta xử lý định tuyến động một cách hiệu quả!## 4. Tích hợp Router với Framework

Bây giờ chúng ta đã có cây Trie hoạt động tốt, bước tiếp theo là tích hợp nó vào framework của chúng ta. Đây là lúc mọi thứ bắt đầu kết nối với nhau!

### Thiết kế Router

Router của chúng ta cần quản lý hai thứ chính:
1. **Các cây Trie** - một cây riêng cho mỗi HTTP method (GET, POST, v.v.)
2. **Các handler** - các hàm xử lý tương ứng với mỗi route

```go
type router struct {
    // Lưu trữ các cây Trie riêng biệt cho mỗi HTTP method
    roots    map[string]*node
    
    // Lưu trữ các handler tương ứng với mỗi route
    handlers map[string]HandlerFunc
}

// Khởi tạo router mới
func newRouter() *router {
    return &router{
        roots:    make(map[string]*node),
        handlers: make(map[string]HandlerFunc),
    }
}
```

Với cấu trúc này, chúng ta có thể:
- Tìm kiếm route nhanh chóng dựa trên HTTP method và path
- Dễ dàng thêm route mới vào hệ thống
- Hỗ trợ các tham số động trong URL

### Phân tích URL pattern

Trước khi thêm route vào cây Trie, chúng ta cần phân tích pattern thành các phần nhỏ:

```go
// Phân tích pattern thành các phần (chỉ cho phép một dấu * duy nhất)
func parsePattern(pattern string) []string {
    vs := strings.Split(pattern, "/")
    parts := make([]string, 0)
    
    for _, item := range vs {
        if item != "" {
            parts = append(parts, item)
            // Nếu gặp wildcard *, dừng lại vì * sẽ khớp với tất cả phần còn lại
            if item[0] == '*' {
                break
            }
        }
    }
    return parts
}
```

Ví dụ:
- `/p/:lang/doc` → `["p", ":lang", "doc"]`
- `/static/*filepath` → `["static", "*filepath"]`

### Đăng ký Route

Khi người dùng gọi `r.GET("/hello/:name", handler)`, chúng ta cần:
1. Phân tích pattern thành các phần
2. Thêm pattern vào cây Trie tương ứng với HTTP method
3. Lưu handler vào map để sử dụng sau này

```go
func (r *router) addRoute(method string, pattern string, handler HandlerFunc) {
    // Phân tích pattern thành các phần
    parts := parsePattern(pattern)
    
    // Tạo key để lưu handler
    key := method + "-" + pattern
    
    // Kiểm tra và tạo cây Trie cho method nếu chưa tồn tại
    _, ok := r.roots[method]
    if !ok {
        r.roots[method] = &node{}
    }
    
    // Thêm pattern vào cây Trie
    r.roots[method].insert(pattern, parts, 0)
    
    // Lưu handler
    r.handlers[key] = handler
}
```

### Tìm Route và Trích xuất Tham số

Khi một request đến, chúng ta cần:
1. Tìm node phù hợp trong cây Trie
2. Trích xuất các tham số động từ URL

```go
func (r *router) getRoute(method string, path string) (*node, map[string]string) {
    // Phân tích path thành các phần
    searchParts := parsePattern(path)
    
    // Map lưu trữ các tham số động
    params := make(map[string]string)
    
    // Lấy cây Trie tương ứng với HTTP method
    root, ok := r.roots[method]
    if !ok {
        return nil, nil
    }

    // Tìm node phù hợp trong cây Trie
    n := root.search(searchParts, 0)

    // Nếu tìm thấy, trích xuất các tham số động
    if n != nil {
        parts := parsePattern(n.pattern)
        
        // So sánh từng phần để tìm và trích xuất tham số
        for index, part := range parts {
            // Xử lý tham số kiểu :param
            if part[0] == ':' {
                // Lưu giá trị thực tế vào map params
                // Ví dụ: với pattern "/user/:name" và path "/user/john"
                // params["name"] = "john"
                params[part[1:]] = searchParts[index]
            }
            
            // Xử lý tham số kiểu *filepath
            if part[0] == '*' && len(part) > 1 {
                // Ghép tất cả phần còn lại của path
                // Ví dụ: với pattern "/static/*filepath" và path "/static/css/style.css"
                // params["filepath"] = "css/style.css"
                params[part[1:]] = strings.Join(searchParts[index:], "/")
                break
            }
        }
        return n, params
    }

    return nil, nil
}
```

### Ví dụ Thực tế

Hãy xem router hoạt động như thế nào với một vài ví dụ:

1. **Route tĩnh**:
   - Pattern: `/users`
   - Request: `/users`
   - Kết quả: Khớp chính xác, không có tham số

2. **Route với tham số động**:
   - Pattern: `/users/:id`
   - Request: `/users/42`
   - Kết quả: Khớp với tham số `id = "42"`

3. **Route với wildcard**:
   - Pattern: `/static/*filepath`
   - Request: `/static/js/app.js`
   - Kết quả: Khớp với tham số `filepath = "js/app.js"`

4. **Route không khớp**:
   - Pattern: `/users/:id`
   - Request: `/posts/42`
   - Kết quả: Không khớp, trả về 404

Với thiết kế này, router của chúng ta có thể xử lý cả đường dẫn tĩnh và động một cách hiệu quả, đồng thời trích xuất các tham số cần thiết để handler có thể sử dụng.

## 4. Hoàn thiện Framework với Context và Tham số Động

Để hoàn thiện framework, chúng ta cần kết nối router với Context và cho phép handler truy cập các tham số động từ URL. Đây là bước cuối cùng để tạo ra một web framework hoàn chỉnh với khả năng định tuyến động.

### Nâng cấp Context để hỗ trợ tham số động

Trước tiên, chúng ta cần mở rộng struct `Context` để lưu trữ và truy xuất các tham số động từ URL:

```go
type Context struct {
    // Đối tượng cơ bản của Go HTTP
    Writer http.ResponseWriter
    Req    *http.Request
    
    // Thông tin về request hiện tại
    Path   string
    Method string
    
    // Tham số động từ URL (mới thêm)
    Params map[string]string
    
    // Mã trạng thái HTTP
    StatusCode int
}

// Phương thức mới để truy xuất tham số động
func (c *Context) Param(key string) string {
    value, _ := c.Params[key]
    return value
}
```

Với việc bổ sung trường `Params` và phương thức `Param()`, handler có thể dễ dàng truy cập các giá trị tham số động. Ví dụ, với route `/user/:id`, handler có thể lấy giá trị của `id` bằng cách gọi `c.Param("id")`.

### Kết nối Router với Context

Tiếp theo, chúng ta cần cập nhật phương thức `handle` của router để truyền các tham số động vào Context:

```go
func (r *router) handle(c *Context) {
    // Tìm route phù hợp và trích xuất tham số
    n, params := r.getRoute(c.Method, c.Path)
    
    if n != nil {
        // Lưu tham số vào Context để handler có thể truy cập
        c.Params = params
        
        // Tìm và gọi handler tương ứng
        key := c.Method + "-" + n.pattern
        r.handlers[key](c)
    } else {
        // Trả về lỗi 404 nếu không tìm thấy route
        c.String(http.StatusNotFound, "404 NOT FOUND: %s\n", c.Path)
    }
}
```

Đoạn code này thực hiện các bước quan trọng:
1. Tìm route phù hợp với request hiện tại
2. Trích xuất các tham số động từ URL
3. Lưu các tham số vào Context
4. Gọi handler tương ứng với route đã tìm thấy

### 5. Kiểm thử Router

Để đảm bảo router hoạt động chính xác, chúng ta viết một số test case:

```go
func newTestRouter() *router {
    r := newRouter()
    r.addRoute("GET", "/", nil)
    r.addRoute("GET", "/hello/:name", nil)
    r.addRoute("GET", "/hello/b/c", nil)
    r.addRoute("GET", "/hi/:name", nil)
    r.addRoute("GET", "/assets/*filepath", nil)
    return r
}

func TestParsePattern(t *testing.T) {
    ok := reflect.DeepEqual(parsePattern("/p/:name"), []string{"p", ":name"})
    ok = ok && reflect.DeepEqual(parsePattern("/p/*"), []string{"p", "*"})
    ok = ok && reflect.DeepEqual(parsePattern("/p/*name/*"), []string{"p", "*name"})
    if !ok {
        t.Fatal("test parsePattern failed")
    }
}

func TestGetRoute(t *testing.T) {
    r := newTestRouter()
    n, ps := r.getRoute("GET", "/hello/geektutu")

    if n == nil {
        t.Fatal("nil shouldn't be returned")
    }

    if n.pattern != "/hello/:name" {
        t.Fatal("should match /hello/:name")
    }

    if ps["name"] != "geektutu" {
        t.Fatal("name should be equal to 'geektutu'")
    }

    fmt.Printf("matched path: %s, params['name']: %s\n", n.pattern, ps["name"])
}
```

Test case này kiểm tra:
- Phân tích pattern thành các phần
- Tìm route phù hợp với URL
- Trích xuất tham số động từ URL

### 6. Sử dụng Framework trong thực tế

Cuối cùng, hãy xem cách sử dụng framework với các tính năng mới:

```go
func main() {
    r := gee.New()
    
    // Route tĩnh
    r.GET("/", func(c *gee.Context) {
        c.HTML(http.StatusOK, "<h1>Hello Gee</h1>")
    })

    // Route với query parameter
    r.GET("/hello", func(c *gee.Context) {
        // Truy cập query parameter: /hello?name=geektutu
        c.String(http.StatusOK, "hello %s, you're at %s\n", 
                 c.Query("name"), c.Path)
    })

    // Route với tham số động
    r.GET("/hello/:name", func(c *gee.Context) {
        // Truy cập tham số động: /hello/geektutu
        c.String(http.StatusOK, "hello %s, you're at %s\n", 
                 c.Param("name"), c.Path)
    })

    // Route với wildcard
    r.GET("/assets/*filepath", func(c *gee.Context) {
        // Truy cập tham số wildcard: /assets/css/style.css
        c.JSON(http.StatusOK, gee.H{
            "filepath": c.Param("filepath"),
        })
    })

    r.Run(":9999")
}
```

Với đoạn code trên, framework của chúng ta có thể:
- Xử lý route tĩnh (`/`)
- Xử lý query parameter (`/hello?name=geektutu`)
- Xử lý tham số động (`/hello/:name`)
- Xử lý wildcard (`/assets/*filepath`)

### Kiểm tra kết quả

Sử dụng công cụ `curl` để kiểm tra các route:

```bash
$ curl "http://localhost:9999/hello/geektutu"
hello geektutu, you're at /hello/geektutu

$ curl "http://localhost:9999/assets/css/geektutu.css"
{"filepath":"css/geektutu.css"}
```

## 7. Tổng kết

### Hạn chế của Triển khai Hiện tại

Mặc dù đã có những tính năng cơ bản, triển khai hiện tại của chúng ta vẫn còn một số hạn chế:

1. **Xung đột route**: Chưa có cơ chế xử lý khi có nhiều route có thể khớp với cùng một URL. Ví dụ, nếu đăng ký cả `/hello/:name` và `/hello/specific`, thì request đến `/hello/specific` có thể khớp với cả hai route.

2. **Thứ tự ưu tiên**: Chưa có quy tắc ưu tiên rõ ràng giữa các route tĩnh và động. Lý tưởng nhất là route tĩnh nên được ưu tiên hơn route động.

3. **Hiệu suất với cây lớn**: Khi số lượng route tăng lên, việc duyệt qua tất cả các node con có thể trở nên kém hiệu quả. Một số tối ưu hóa có thể được áp dụng.

4. **Hỗ trợ regex hạn chế**: Hiện tại chúng ta chỉ hỗ trợ hai loại tham số động (`:param` và `*wildcard`), nhưng chưa hỗ trợ các mẫu regex phức tạp hơn.

5. **Xử lý lỗi đơn giản**: Chúng ta chỉ trả về lỗi 404 đơn giản khi không tìm thấy route, nhưng chưa có cơ chế xử lý lỗi toàn diện.

Những hạn chế này sẽ được giải quyết trong các phần tiếp theo khi chúng ta tiếp tục phát triển framework.

### Tiếp theo

Trong các phần tiếp theo, chúng ta sẽ bổ sung thêm các tính năng nâng cao như middleware, nhóm route, và template rendering để biến Gee thành một web framework hoàn chỉnh hơn.

Hãy tiếp tục theo dõi chuỗi bài viết để xem cách chúng ta giải quyết những thách thức này và thêm các tính năng mới!

