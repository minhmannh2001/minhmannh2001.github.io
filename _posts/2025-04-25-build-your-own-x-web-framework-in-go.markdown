---
layout: post
title: 'Build your own X: Tự xây dựng một web framework với Go - Giới thiệu'
date: '2025-04-25 23:58'
excerpt: >-
  Giới thiệu chuỗi bài viết về cách xây dựng một web framework bằng Go, nhằm giúp bạn hiểu sâu hơn về cách hoạt động của một web framework – từ net/http cơ bản đến router, middleware và nhiều chức năng quan trọng khác của một web framework.
comments: false
---

## Giới thiệu đôi nét về bản thân

Với mục tiêu xây dựng một blog cá nhân để chia sẻ kiến thức lập trình, ban đầu mình cũng khá bối rối vì chưa nghĩ ra nên viết gì. Trong lúc đọc lại những bài viết hay mà mình từng lưu, mình chợt nảy ra một ý tưởng: thay vì cố nghĩ ra chủ đề mới, chuẩn bị thật kỹ lưỡng cho một bài viết "chỉnh chu", thì tại sao không bắt đầu bằng việc dịch và viết lại những bài viết chất lượng mà mình đã đọc – theo cách hiểu và cách diễn đạt của riêng mình.

Mục tiêu là vừa học, vừa viết, không trì hoãn. Mình hy vọng qua mỗi bài viết, kỹ năng trình bày của mình sẽ tiến bộ dần. Ban đầu có thể vẫn còn lủng củng, có chỗ chưa dễ hiểu dù mình luôn cố gắng diễn giải sao cho đơn giản nhất có thể. Nhưng mình tin rằng: khi mình đủ hiểu để có thể kể lại một cách rõ ràng, thì bản thân mình cũng học được rất nhiều.

## Giới thiệu về chuỗi bài viết xây dựng web framework

Đây là bài viết mở đầu cho chuỗi bài viết mình dịch và diễn giải lại loạt bài hướng dẫn xây dựng Web Framework Gee bằng ngôn ngữ Go, được đăng trên blog geektutu.com — một blog với chuỗi bài 7 ngày học golang khá hay. 

Mặc dù hiện nay việc đọc tài liệu tiếng Trung đã dễ dàng hơn rất nhiều nhờ Google Dịch hay các công cụ AI, nhưng mình vẫn muốn dịch và diễn giải lại bằng góc nhìn của riêng mình. Vừa là cách để tự học, vừa là cơ hội để chia sẻ lại cho các bạn theo cách gần gũi, dễ hiểu hơn. Mình hy vọng qua chuỗi bài này, các bạn sẽ có cảm giác như đang có một người bạn đồng hành cùng học, cùng tìm hiểu và cùng vượt qua từng phần kiến thức một cách nhẹ nhàng hơn.

Hy vọng chuỗi bài sẽ hữu ích cho các bạn đang học hoặc làm việc với Golang, hoặc đơn giản là đang tò mò muốn biết một framework web được xây dựng như thế nào từ con số 0.

## Phần mở đầu của chuỗi bài viết

Khi bắt tay vào xây dựng một ứng dụng web, điều đầu tiên thường khiến chúng ta băn khoăn là: nên dùng framework nào? Ở mỗi ngôn ngữ lập trình, có rất nhiều framework với tư duy thiết kế và tính năng rất khác nhau — như trong Python có Django với đầy đủ tính năng, hay Flask với thiết kế tối giản; trong Go thì có Beego, Gin, Iris, v.v.

Nhưng đã bao giờ bạn tự hỏi: liệu chỉ dùng thư viện chuẩn (standard library) có đủ để viết một ứng dụng web không? Và rốt cuộc, framework thực sự giúp chúng ta giải quyết điều gì?

Chuỗi bài viết này là hành trình từng bước xây dựng một web framework đơn giản bằng ngôn ngữ Go, mang tên Gee - với sự tham khảo từ Gin. Qua từng bài viết, bạn sẽ được hướng dẫn từng bước tạo nên một framework nhỏ gọn, nhưng thể hiện đầy đủ những thành phần cốt lõi nhất của một web framework hiện đại: xử lý routing, middleware, template, phục hồi khi panic, v.v.

Điều thú vị là, dù Gee đơn giản hơn rất nhiều so với các framework ngoài kia, nhưng qua mỗi phần bạn sẽ hiểu sâu hơn những vấn đề mà framework thực sự giải quyết — và tại sao chúng lại cần thiết.

Nếu bạn là người thích tìm hiểu từ gốc rễ, hoặc đơn giản là muốn “tự tay làm lấy một framework”, thì chuỗi bài viết này chính là khởi đầu tuyệt vời.

## Nội dung chuỗi bài viết

Nội dung chuỗi gồm 7 phần:

1. **Phần 1**: Tổng quan về thư viện net/http và http.Handler interface
2. **Phần 2**: Context — xây dựng lớp trung gian để truyền dữ liệu qua các handler
3. **Phần 3**: Router sử dụng cây Trie để tăng hiệu năng định tuyến
4. **Phần 4**: Group control — tổ chức các route hợp lý
5. **Phần 5**: Middleware — xây dựng các chức năng cắm ngoài
6. **Phần 6**: Template HTML — render giao diện người dùng
7. **Phần 7**: Cơ chế khôi phục khi xảy ra panic

Hy vọng bản dịch này giúp bạn hiểu rõ hơn về cách các framework web hoạt động từ bên trong — và có thể truyền cảm hứng cho bạn trong hành trình làm chủ ngôn ngữ Go và lập trình backend.
