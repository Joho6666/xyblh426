# 校区字段一次性迁移（历史数据）

上线「按校区隔离」后，请执行一次迁移，把缺少 `campusId` 的帖子、闲置、用户默认归到 **桂林航天工业学院**（`guit-hangtian`）。

## 方式一：管理员在小程序里临时调用（推荐）

使用管理员账号登录后，在任意页控制台或临时按钮里执行一次：

```javascript
const app = getApp()
app.callDB('migrateCampusDefaults', {}).then(console.log).catch(console.error)
```

云函数 `dbOperations` 会校验 **管理员身份**，并批量更新：

- `posts`：无 `campusId` 或为空字符串 → `campusId: guit-hangtian`
- `market_goods`：同上
- `users`：同上，并写入 `campusName`、`college` 为「桂林航天工业学院」

返回结果中的 `postsUpdated` / `goodsUpdated` / `usersUpdated` 为本次更新条数（受云开发单次更新上限影响，若数据量极大可多次执行直至为 0）。

## 方式二：云开发控制台

在控制台数据库中，对 `posts`、`market_goods`、`users` 自行编写条件更新（与上同逻辑），注意先在测试环境验证。

## 方式三：本机 CloudBase CLI（`tcb fn invoke`）

适用于已 `tcb login` 且项目根目录含 `cloudbaserc.json` 的环境。请求体中的 `webSecret` 必须与云函数环境变量 **`ADMIN_WEB_SECRET`** 一致（与 `callAdminPanel` 同源），**切勿**把密钥写进小程序前端或公开仓库。

先部署最新 `dbOperations`，再在 `campus_treehole` 目录执行。Windows 下 `--params` 易被 shell 破坏，建议用 **`-d @文件`**（与 `curl` 类似）：

```powershell
npx -p @cloudbase/cli@latest tcb fn deploy dbOperations --yes
# 将下面 $sec 换成与云端 dbOperations 环境变量 ADMIN_WEB_SECRET 一致的值（勿提交到仓库）
@'
{"action":"migrateCampusDefaults","data":{"webSecret":"在此粘贴密钥"}}
'@ | Set-Content -Encoding utf8 .\invoke-migrate.json
npx -p @cloudbase/cli@latest tcb fn invoke dbOperations -e <你的envId> -d @invoke-migrate.json --json
Remove-Item .\invoke-migrate.json
```

`envId` 取自 `cloudbaserc.json` 顶层字段。返回 `postsUpdated` / `goodsUpdated` / `usersUpdated` 为 0 表示已无缺字段文档；若单次有上限，可重复执行直至均为 0。

## 客户端

校区列表与默认 ID 定义在小程序 `utils/campuses.js`，须与云函数 `dbOperations/index.js` 顶部 `DEFAULT_CAMPUS_ID` 保持一致。
