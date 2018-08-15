const notifier = require('node-notifier')
const childProcess = require('child_process')
const isWindows = /^win/.test(process.platform)

const babelBrowserConfig = {
  babelrc: false,
  'presets': [
    ['env', {
      modules: false,
      loose: true,
      targets: {
        browsers: ['ie >= 11', 'edge >= 16', 'safari >= 9', 'chrome >= 64', 'firefox >= 60']
      },
      exclude: ['transform-es2015-typeof-symbol', 'transform-es2015-function-name'],
      useBuiltIns: true,
      debug: true
    }],
    'react'
  ],
  'plugins': [
    'transform-object-rest-spread',
    'transform-class-properties',
    'transform-react-remove-prop-types',
    ['transform-runtime', {
      helpers: true,
      polyfill: false
    }]
  ]
}
const babelNodeConfig = {
  babelrc: false,
  presets: [
    ['env', {
      targets: {
        node: 'current'
      }
    }],
    'react'
  ],
  plugins: ['transform-object-rest-spread', 'transform-class-properties']
}

export async function compile (task) {
  await task.serial(['bin', 'server', 'browserLib', 'nodeLib', 'client'])
}

export async function bin (task, opts) {
  await task.source('bin/*').babel(babelNodeConfig).target('node/bin', {mode: '0755'})
  notify('Compiled binaries')
}

export async function browserLib (task, opts) {
  await task.source('lib/**/*.js').babel(babelBrowserConfig).target('browser/lib')
  notify('Compiled browser lib files')
}
export async function nodeLib (task, opts) {
  await task.source('lib/**/*.js').babel(babelNodeConfig).target('node/lib')
  notify('Compiled node lib files')
}

export async function server (task, opts) {
  await task.source('server/**/*.js').babel(babelNodeConfig).target('node/server')
  notify('Compiled server files')
}

export async function client (task, opts) {
  await task.source('client/**/*.js').babel(babelBrowserConfig).target('browser/client')
  notify('Compiled client files')
}

export async function build (task) {
  await task.serial(['compile'])
}

export default async function (task) {
  await task.start('build')
  await task.watch('bin/*', 'bin')
  await task.watch('server/**/*.js', 'server')
  await task.watch('client/**/*.js', 'client')
  await task.watch('lib/**/*.js', 'nodeLib')
  await task.watch('lib/**/*.js', 'browserLib')
}

export async function release (task) {
  await task.clear('node').clear('browser').start('build')
}

// We run following task inside a NPM script chain and it runs chromedriver
// inside a child process tree.
// Even though we kill this task's process, chromedriver exists throughout
// the lifetime of the original npm script.

export async function pretest (task) {
  const processName = isWindows ? 'chromedriver.cmd' : 'chromedriver'
  childProcess.spawn(processName, { stdio: 'inherit' })
  // We need to do this, otherwise this task's process will keep waiting.
  setTimeout(() => process.exit(0), 2000)
}

export async function posttest (task) {
  try {
    const cmd = isWindows ? 'taskkill /im chromedriver* /t /f' : 'pkill chromedriver'
    childProcess.execSync(cmd, { stdio: 'ignore' })
  } catch (err) {
    // Do nothing
  }
}

// notification helper
function notify (msg) {
  return notifier.notify({
    title: '▲ Next',
    message: msg,
    icon: false
  })
}
