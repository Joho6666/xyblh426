/**
 * Create unique index on user_blocks via tcb (collection should exist first).
 * Uses double JSON.stringify so Windows cmd passes a single --command argument.
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
    Command: JSON.stringify({
      createIndexes: 'user_blocks',
      indexes: [
        {
          key: { blockerOpenid: 1, blockedOpenid: 1 },
          name: 'uniq_blocker_blocked',
          unique: true
        }
      ]
    })
  }
]

const cmdArg = JSON.stringify(JSON.stringify(commands))
const line = `"${tcb}" db nosql execute -e ${ENV_ID} --json --command ${cmdArg}`
execSync(line, { cwd: root, stdio: 'inherit', shell: true, windowsHide: true })
