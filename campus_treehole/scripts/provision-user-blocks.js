/**
 * 调用云函数 dbOperations：检测 user_blocks 是否可访问（云函数内不会 createCollection，表需在控制台或 tcb nosql 预先创建）
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'cloudbaserc.json'), 'utf8'))
const envId = cfg.envId
const secret = (cfg.functions || []).find((f) => f.name === 'dbOperations')?.envVariables?.ADMIN_WEB_SECRET
if (!secret) {
  console.error('cloudbaserc.json 中未找到 dbOperations.envVariables.ADMIN_WEB_SECRET')
  process.exit(1)
}

const payload = JSON.stringify({
  action: 'provisionUserBlocksSchema',
  data: { webSecret: secret }
})
const tmp = path.join(require('os').tmpdir(), 'invoke-provision-user-blocks.json')
fs.writeFileSync(tmp, payload, 'utf8')

const tcb = path.join(root, 'node_modules', '.bin', 'tcb.cmd')
const line = `"${tcb}" fn invoke dbOperations -e ${envId} -d @${tmp} --json`
execSync(line, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true })
