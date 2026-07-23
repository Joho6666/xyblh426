/**
 * 用 tcb db nosql 创建空集合 user_blocks（云函数运行时不可 createCollection）
 */
const { execSync } = require('child_process')
const path = require('path')

const ENV_ID = 'xyblh-5gb26qrnf9d30feb'
const root = path.resolve(__dirname, '..')
const tcb = path.join(root, 'node_modules', '.bin', 'tcb.cmd')

const commands = [
  {
    TableName: 'user_blocks',
    CommandType: 'COMMAND',
    Command: JSON.stringify({ create: 'user_blocks' })
  }
]
const cmdArg = JSON.stringify(JSON.stringify(commands))
const line = `"${tcb}" db nosql execute -e ${ENV_ID} --json --command ${cmdArg}`
execSync(line, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true })
