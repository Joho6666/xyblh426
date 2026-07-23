# 管理后台静态托管

H5 管理后台源文件请维护在仓库外 `Desktop/admin后台`，部署前复制为本目录 `admin.html`（**必须有 `.html` 扩展名**），否则 COS 会识别为 `application/octet-stream`，浏览器会下载而不是打开页面。

访问地址：

https://xyblh-5gb26qrnf9d30feb-1420065347.tcloudbaseapp.com/admin.html

部署：在项目根目录执行 `npm run admin:deploy`（需已登录 CloudBase CLI）。
