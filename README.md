# Edupia Classroom Server

Một máy chủ dùng chung cho **mọi** game tạo bằng skill `edupiagamebuilder`. Triển khai một lần; game mới chỉ cần trỏ `serverUrl` vào đây.

## Chạy

```bash
npm ci
cp .env.example .env     # sửa các giá trị
npm test                 # toàn bộ test admin, security và luồng lớp học phải đạt
npm run admin -- create <tên-chủ-nội-dung>   # in ra mật khẩu dùng một lần (72 giờ)
npm start                # mặc định cổng 8080, WebSocket ở /ws
```
Đặt sau reverse proxy HTTPS (nginx/Cloudflare) và cho phép nâng cấp WebSocket ở `/ws`. Proxy phải gửi `X-Forwarded-Proto` và `X-Forwarded-For`; đặt `TRUST_PROXY` bằng số proxy phía trước.

Thử trong mạng nội bộ, kèm phục vụ file game:
```bash
node server.js --games ../games      # mở http://<ip-máy>:8080/<ten-game>/teacher.html
```

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `PORT` | cổng HTTP/WS |
| `ALLOWED_ORIGINS` | origin của trang chứa game, phân tách bằng dấu phẩy. Kết nối từ origin khác bị từ chối |
| `TEACHER_ACCOUNTS` | JSON ánh xạ từng `teacherId` sang secret riêng; chỉ dùng trước khi nối SSO |
| `ADMIN_ORIGIN` | origin công khai của máy chủ, ví dụ `https://classroom.edupia.vn`; mọi thao tác ghi ở `/admin` phải đến từ đúng origin này |
| `TRUST_PROXY` | số reverse proxy phía trước (0 = không có). Cần để `/admin` nhận biết HTTPS và IP thật của người dùng |
| `CONTENT_HOSTS` | host được phép đọc nguồn câu hỏi (ví dụ `docs.google.com`) |
| `DATA_DIR` | nơi lưu `sources.json`, `admins.json` (tài khoản quản trị), `audit.log` (nhật ký kiểm toán) — ổ bền, quyền chỉ chủ sở hữu, có sao lưu |
| `AUDIT_ANCHOR_FILE` | bản đối chứng ngoài `DATA_DIR`; dùng `anchor-audit` để phát hiện nhật ký bị cắt cuối |
| `GAMES_DIR` | tùy chọn, phục vụ file game để thử nội bộ; không dùng cho production |

## Việc IT cần làm

1. **`auth.js` → `authenticateTeacher`**: thay fallback tài khoản riêng bằng xác thực Edupia (cookie/JWT). Không dùng một khóa chung cho nhiều giáo viên.
2. **Quyền đọc nguồn**: mặc định máy chủ đọc bản xuất text của Google Docs. Cần giữ kín đáp án thì đổi `content-source.js` sang Drive/Sheets API với service account.
3. **Phục hồi/nhiều instance**: phòng đang nằm trong RAM. Reload/mất mạng reconnect được khi tiến trình còn sống; restart máy chủ làm mất phòng. Chuyển `rooms` + token sang Redis/database nếu cần phục hồi hoặc scale ngang.
4. **Giám sát**: `GET /healthz` trả số phòng đang mở. Gom dòng `AUDIT ` về log tập trung; định kỳ `verify-audit` và `anchor-audit` khi có `AUDIT_ANCHOR_FILE`.
5. **Tài khoản quản trị**: xem mục dưới.

## Tài khoản quản trị `/admin`

| Lệnh | Việc |
|---|---|
| `npm run admin -- create <tên>` | tạo tài khoản, in mật khẩu dùng một lần (hết hạn 72 giờ, buộc đổi khi đăng nhập lần đầu) |
| `npm run admin -- reset <tên>` | quên mật khẩu: cấp mật khẩu dùng một lần mới, thu hồi mọi phiên |
| `npm run admin -- disable <tên>` / `enable <tên>` | khóa / mở tài khoản; khóa là phiên chết ngay |
| `npm run admin -- list` | trạng thái tài khoản (không in hash) |
| `npm run admin -- scope <tên> <game,...>` | giới hạn theo game hoặc tiền tố khối, ví dụ `grade-3-*` |
| `npm run admin -- verify-audit` | kiểm tra chuỗi băm của `audit.log` |
| `npm run admin -- anchor-audit` | cập nhật bản đối chứng bên ngoài |

Không có trang thiết lập lần đầu trên web và không có "quên mật khẩu qua email" — cả hai là lỗ hổng phổ biến. Người dùng tự đổi mật khẩu ngay trong `/admin`. `ADMIN_TOKEN` của bản cũ không còn dùng; máy chủ cảnh báo nếu còn đặt.

Trang `/admin` chỉ chạy qua HTTPS (hoặc `http://localhost` khi thử trên chính máy chủ). Phiên nằm trong RAM: khởi động lại máy chủ là phải đăng nhập lại.

## Những gì đã có sẵn

Chấm điểm/hẹn giờ phía máy chủ, chống bấm kép, pause, khóa phòng, kick, chính sách vào muộn/công bố đáp án, reconnect, sáu dạng bài chuẩn, lược đáp án, giới hạn socket và CSP. `/admin` có tài khoản riêng, scope, bản nháp → kiểm tra → xuất bản, lịch sử/khôi phục và audit.

## Giao thức

Xem `references/architecture.md` trong skill. Room Protocol v2 dùng `{v:2, id, op, payload}`; máy chủ tự chấm answer thô theo snapshot của vòng.
