import { join, relative, sep } from 'path'
import WebpackDevMiddleware from 'webpack-dev-middleware'
import WebpackHotMiddleware from 'webpack-hot-middleware'
import onDemandEntryHandler from './on-demand-entry-handler'
import webpack from './build/webpack'
import clean from './build/clean'
import getConfig from './config'
import { IS_BUNDLED_PAGE } from './utils'
import { watch } from './build/babel'

export default class HotReloader {
  constructor (dir, { quiet, conf } = {}) {
    this.dir = dir
    this.quiet = quiet
    this.middlewares = []
    this.webpackDevMiddleware = null
    this.webpackHotMiddleware = null
    this.initialized = false
    this.stats = null
    this.compilationErrors = null
    this.prevChunkNames = null
    this.prevFailedChunkNames = null
    this.prevChunkHashes = null

    this.config = getConfig(dir, conf)
  }

  async run (req, res) {
    for (const fn of this.middlewares) {
      await new Promise((resolve, reject) => {
        fn(req, res, (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }
  }

  async start () {
    const [webpackCompiler] = await Promise.all([
      webpack(this.dir, { dev: true, quiet: this.quiet }),
      clean(this.dir)
    ])
    const babelCompiler = {
      setEntry: (name, pathname) => {
        watch([pathname], {
          base: this.dir,
          outDir: join(this.dir, '.next', 'server')
        }, (msg) => {
          if (msg.cmd === 'file-built') {
            deleteCache(msg.dest)
            msg.parents.forEach(deleteCache)
          }
        })
      }
    }
    await babelCompiler.setEntry('_error', `${this.dir}/pages/_error.js`)
    await babelCompiler.setEntry('_document', `${this.dir}/pages/_document.js`)

    const buildTools = await this.prepareBuildTools(webpackCompiler, babelCompiler)
    this.assignBuildTools(buildTools)

    this.stats = await this.waitUntilValid()
  }

  async stop (webpackDevMiddleware) {
    const middleware = webpackDevMiddleware || this.webpackDevMiddleware
    if (middleware) {
      return new Promise((resolve, reject) => {
        middleware.close((err) => {
          if (err) return reject(err)
          resolve()
        })
      })
    }
  }

  async reload () {
    this.stats = null

    const [compiler] = await Promise.all([
      webpack(this.dir, { dev: true, quiet: this.quiet }),
      clean(this.dir)
    ])

    const buildTools = await this.prepareBuildTools(compiler)
    this.stats = await this.waitUntilValid(buildTools.webpackDevMiddleware)

    const oldWebpackDevMiddleware = this.webpackDevMiddleware

    this.assignBuildTools(buildTools)
    await this.stop(oldWebpackDevMiddleware)
  }

  assignBuildTools ({ webpackDevMiddleware, webpackHotMiddleware, onDemandEntries }) {
    this.webpackDevMiddleware = webpackDevMiddleware
    this.webpackHotMiddleware = webpackHotMiddleware
    this.onDemandEntries = onDemandEntries
    this.middlewares = [
      webpackDevMiddleware,
      webpackHotMiddleware,
      onDemandEntries.middleware()
    ]
  }

  async prepareBuildTools (webpackCompiler, babelCompiler) {
    webpackCompiler.plugin('done', (stats) => {
      const { compilation } = stats
      const chunkNames = new Set(
        compilation.chunks
          .map((c) => c.name)
          .filter(name => IS_BUNDLED_PAGE.test(name))
      )

      const failedChunkNames = new Set(compilation.errors
        .map((e) => e.module.reasons)
        .reduce((a, b) => a.concat(b), [])
        .map((r) => r.module.chunks)
        .reduce((a, b) => a.concat(b), [])
        .map((c) => c.name))

      const chunkHashes = new Map(
        compilation.chunks
          .filter(c => IS_BUNDLED_PAGE.test(c.name))
          .map((c) => [c.name, c.hash])
      )

      if (this.initialized) {
        // detect chunks which have to be replaced with a new template
        // e.g, pages/index.js <-> pages/_error.js
        const added = diff(chunkNames, this.prevChunkNames)
        const removed = diff(this.prevChunkNames, chunkNames)
        const succeeded = diff(this.prevFailedChunkNames, failedChunkNames)

        // reload all failed chunks to replace the templace to the error ones,
        // and to update error content
        const failed = failedChunkNames

        const rootDir = 'pages'

        for (const n of new Set([...added, ...removed, ...failed, ...succeeded])) {
          const route = toRoute(relative(rootDir, n))
          this.send('reload', route)
        }

        for (const [n, hash] of chunkHashes) {
          if (!this.prevChunkHashes.has(n)) continue
          if (this.prevChunkHashes.get(n) === hash) continue

          const route = toRoute(relative(rootDir, n))

          // notify change to recover from runtime errors
          this.send('change', route)
        }
      }

      this.initialized = true
      this.stats = stats
      this.compilationErrors = null
      this.prevChunkNames = chunkNames
      this.prevFailedChunkNames = failedChunkNames
      this.prevChunkHashes = chunkHashes
    })

    const ignored = [
      /(^|[/\\])\../, // .dotfiles
      /node_modules/
    ]

    let webpackDevMiddlewareConfig = {
      publicPath: `/_next/-/webpack/`,
      noInfo: true,
      quiet: true,
      clientLogLevel: 'warning',
      watchOptions: { ignored }
    }

    if (this.config.webpackDevMiddleware) {
      console.log(`> Using "webpackDevMiddleware" config function defined in ${this.config.configOrigin}.`)
      webpackDevMiddlewareConfig = this.config.webpackDevMiddleware(webpackDevMiddlewareConfig)
    }

    const webpackDevMiddleware = WebpackDevMiddleware(webpackCompiler, webpackDevMiddlewareConfig)

    const webpackHotMiddleware = WebpackHotMiddleware(webpackCompiler, {
      path: '/_next/webpack-hmr',
      log: false,
      heartbeat: 2500
    })
    const onDemandEntries = onDemandEntryHandler(webpackDevMiddleware, webpackCompiler, babelCompiler, {
      dir: this.dir,
      dev: true,
      reload: this.reload.bind(this),
      ...this.config.onDemandEntries
    })

    return {
      webpackDevMiddleware,
      webpackHotMiddleware,
      onDemandEntries
    }
  }

  waitUntilValid (webpackDevMiddleware) {
    const middleware = webpackDevMiddleware || this.webpackDevMiddleware
    return new Promise((resolve) => {
      middleware.waitUntilValid(resolve)
    })
  }

  async getCompilationErrors () {
    // When we are reloading, we need to wait until it's reloaded properly.
    await this.onDemandEntries.waitUntilReloaded()

    if (!this.compilationErrors) {
      this.compilationErrors = new Map()

      if (this.stats.hasErrors()) {
        const { compiler, errors } = this.stats.compilation

        for (const err of errors) {
          for (const r of err.module.reasons) {
            for (const c of r.module.chunks) {
              // get the path of the bundle file
              const path = join(compiler.outputPath, c.name)
              const errors = this.compilationErrors.get(path) || []
              this.compilationErrors.set(path, errors.concat([err]))
            }
          }
        }
      }
    }

    return this.compilationErrors
  }

  send (action, ...args) {
    this.webpackHotMiddleware.publish({ action, data: args })
  }

  ensurePage (page) {
    return this.onDemandEntries.ensurePage(page)
  }
}

function deleteCache (path) {
  delete require.cache[path]
}

function diff (a, b) {
  return new Set([...a].filter((v) => !b.has(v)))
}

function toRoute (file) {
  const f = sep === '\\' ? file.replace(/\\/g, '/') : file
  return ('/' + f).replace(/(\/index)?\.js$/, '') || '/'
}
