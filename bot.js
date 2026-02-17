const TelegramBot = require('node-telegram-bot-api')
const fs = require('fs').promises
const path = require('path')
const { Worker } = require('worker_threads')
require('dotenv').config()

function formatServerTime(date = new Date()) {
  // 返回服务器本地时间字符串，格式如：2025-07-10 15:30:45
  const pad = n => n.toString().padStart(2, '0')
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds())
  )
}

function cutTextByLength(str, maxLen) {
  if (!str) return ''
  // [...str] 可以正确处理 emoji 和中文等多字节字符
  const arr = [...str]
  if (arr.length <= maxLen) return str
  return arr.slice(0, maxLen).join('') + '...'
}

function removeLineBreaks(str) {
  if (!str) return ''
  return str.replace(/[\r\n]+/g, '')
}

function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'undefined') return defaultValue
  return String(value).toLowerCase() === 'true'
}

class TelegramRSSBot {
  constructor() {
    // 初始化配置
    this.botToken = process.env.BOT_TOKEN
    this.rssUrls = process.env.RSS_URLS
      ? process.env.RSS_URLS.split(',').map(url => url.trim())
      : []
    this.scanInterval = parseInt(process.env.SCAN_INTERVAL) || 30
    this.groupIds = process.env.GROUP_IDS
      ? process.env.GROUP_IDS.split(',').map(id => id.trim())
      : []
    this.dataFile = process.env.DATA_FILE || 'rss_data.json'
    this.ollamaEnabled = parseBoolean(process.env.OLLAMA_ENABLED, false)
    this.ollamaApiUrl = (process.env.OLLAMA_API_URL || '').trim()
    this.ollamaModel = (process.env.OLLAMA_MODEL || '').trim()
    this.ollamaSystemPrompt =
      process.env.OLLAMA_SYSTEM_PROMPT || '你是一个有用的助手。'
    this.ollamaTimeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS) || 30000
    this.ollamaQueueMaxSize = 50
    this.botId = null
    this.botUsername = ''

    // 初始化组件
    this.bot = new TelegramBot(this.botToken, { polling: true })
    this.lastArticles = new Map()
    this.intervalId = null
    this.isScanning = false
    this.isStop = false
    this.ollamaQueue = []
    this.isOllamaProcessing = false
    this.stats = {
      totalScans: 0,
      totalArticlesSent: 0,
      lastScanTime: null
    }

    // 绑定方法
    this.init = this.init.bind(this)
    this.loadData = this.loadData.bind(this)
    this.saveData = this.saveData.bind(this)
    this.scanRSSFeeds = this.scanRSSFeeds.bind(this)
    this.processRSSFeed = this.processRSSFeed.bind(this)
    this.sendToGroups = this.sendToGroups.bind(this)
    this.setupBotCommands = this.setupBotCommands.bind(this)
    this.startScheduler = this.startScheduler.bind(this)
    this.initBotProfile = this.initBotProfile.bind(this)
    this.isBotMentioned = this.isBotMentioned.bind(this)
    this.extractMentionPrompt = this.extractMentionPrompt.bind(this)
    this.chatWithOllama = this.chatWithOllama.bind(this)
    this.handleMentionMessage = this.handleMentionMessage.bind(this)
    this.enqueueOllamaTask = this.enqueueOllamaTask.bind(this)
    this.processOllamaQueue = this.processOllamaQueue.bind(this)

    console.log('🤖 Telegram RSS Bot 初始化中...')
    this.validateConfig()
  }

  // 验证配置
  validateConfig() {
    if (!this.botToken) {
      throw new Error('❌ 缺少 BOT_TOKEN 环境变量')
    }

    if (this.rssUrls.length === 0) {
      throw new Error('❌ 缺少 RSS_URLS 环境变量')
    }

    if (this.groupIds.length === 0) {
      throw new Error('❌ 缺少 GROUP_IDS 环境变量')
    }

    if (this.ollamaEnabled) {
      if (!this.ollamaApiUrl) {
        throw new Error('❌ 已开启 OLLAMA_ENABLED，但缺少 OLLAMA_API_URL')
      }
      if (!this.ollamaModel) {
        throw new Error('❌ 已开启 OLLAMA_ENABLED，但缺少 OLLAMA_MODEL')
      }
    }

    console.log('✅ 配置验证通过')
    console.log(`📡 RSS源数量: ${this.rssUrls.length}`)
    console.log(`👥 群组数量: ${this.groupIds.length}`)
    console.log(`⏰ 扫描间隔: ${this.scanInterval} 分钟`)
    console.log(`🧠 Ollama聊天: ${this.ollamaEnabled ? '已开启' : '已关闭'}`)
    if (this.ollamaEnabled) {
      console.log(`🧾 Ollama队列上限: ${this.ollamaQueueMaxSize}`)
    }
  }

  // 检查是否为管理员或群主
  async isAdmin(chatId, userId) {
    // 只在配置的群组中处理
    if (!this.groupIds.includes(chatId.toString())) return false

    try {
      const chatMember = await this.bot.getChatMember(chatId, userId)
      return ['creator', 'administrator'].includes(chatMember.status)
    } catch (error) {
      console.error('❌ 权限检查失败:', error)
      return false
    }
  }

  // 初始化机器人
  async init() {
    try {
      await this.loadData()
      await this.initBotProfile()
      this.setupBotCommands()
      this.startScheduler()

      console.log('🚀 机器人启动成功！')

      // 启动时执行一次扫描
      setTimeout(() => {
        this.scanRSSFeeds()
      }, 5000)
    } catch (error) {
      console.error('❌ 机器人初始化失败:', error)
      process.exit(1)
    }
  }

  // 初始化机器人资料
  async initBotProfile() {
    try {
      const me = await this.bot.getMe()
      this.botId = me.id
      this.botUsername = me.username || ''
      console.log(`🤖 机器人用户名: @${this.botUsername || '未知'}`)
    } catch (error) {
      console.error('❌ 获取机器人资料失败:', error)
      throw error
    }
  }

  // 加载历史数据
  async loadData() {
    try {
      const dataPath = path.join(__dirname, this.dataFile)
      const data = await fs.readFile(dataPath, 'utf8')
      const parsed = JSON.parse(data)

      this.lastArticles = new Map(Object.entries(parsed.lastArticles || {}))
      this.stats = { ...this.stats, ...parsed.stats }

      // 不加载 errors 到内存中，只保留在文件里

      console.log(`📂 加载历史数据: ${this.lastArticles.size} 条记录`)
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('📂 未找到历史数据文件，将创建新文件')
        this.lastArticles = new Map()
      } else {
        console.error('❌ 加载历史数据失败:', error)
      }
    }
  }

  // 保存数据
  async saveData() {
    try {
      const dataPath = path.join(__dirname, this.dataFile)

      // 读取现有数据以获取 errors
      let existingErrors = []
      try {
        const existingData = await fs.readFile(dataPath, 'utf8')
        const parsed = JSON.parse(existingData)
        existingErrors = parsed.errors || []
      } catch (error) {
        // 文件不存在或解析错误，使用空数组
      }

      const data = {
        lastArticles: Object.fromEntries(this.lastArticles),
        stats: this.stats,
        errors: existingErrors, // 保留现有的错误记录
        lastSaved: new Date().toISOString()
      }
      await fs.writeFile(dataPath, JSON.stringify(data, null, 2))
      console.log('💾 数据已保存')
    } catch (error) {
      console.error('❌ 保存数据失败:', error)
    }
  }

  // 保存错误记录到文件
  async saveError(url, error) {
    try {
      const dataPath = path.join(__dirname, this.dataFile)

      // 读取现有数据
      let data = {}
      try {
        const existingData = await fs.readFile(dataPath, 'utf8')
        data = JSON.parse(existingData)
      } catch (readError) {
        // 文件不存在或解析错误，使用空对象
        data = {
          lastArticles: Object.fromEntries(this.lastArticles),
          stats: this.stats,
          errors: []
        }
      }

      // 添加新错误
      const newError = {
        url,
        error: error.message,
        timestamp: new Date().toISOString()
      }

      data.errors = data.errors || []
      data.errors.push(newError)

      // 只保留最近50个错误
      if (data.errors.length > 50) {
        data.errors = data.errors.slice(-50)
      }

      // 更新其他数据
      data.lastArticles = Object.fromEntries(this.lastArticles)
      data.stats = this.stats
      data.lastSaved = new Date().toISOString()

      await fs.writeFile(dataPath, JSON.stringify(data, null, 2))
    } catch (saveError) {
      console.error('❌ 保存错误记录失败:', saveError)
    }
  }

  // 显示内存使用情况
  showMemoryUsage() {
    const memUsage = process.memoryUsage()
    const formatBytes = bytes => {
      return (bytes / 1024 / 1024).toFixed(2) + ' MB'
    }

    console.log('📊 内存使用情况:')
    console.log(`   RSS: ${formatBytes(memUsage.rss)} (总内存)`)
    console.log(`   Heap Used: ${formatBytes(memUsage.heapUsed)} (堆内存使用)`)
    console.log(
      `   Heap Total: ${formatBytes(memUsage.heapTotal)} (堆内存总量)`
    )
    console.log(`   External: ${formatBytes(memUsage.external)} (外部内存)`)
  }

  // 扫描所有RSS源
  async scanRSSFeeds() {
    // 检查是否已经在扫描中
    if (this.isScanning) {
      console.log('⏭️ 上一次扫描仍在进行中，跳过本次扫描')
      return
    }

    const previousScanTime = this.stats.lastScanTime // 获取本次扫描前的最后一次扫描时间
    this.isScanning = true
    console.log('🔍 开始扫描RSS源...')
    this.stats.totalScans++
    this.stats.lastScanTime = new Date().toISOString()

    let totalNewArticles = 0

    try {
      for (const url of this.rssUrls) {
        if (this.isStop) {
          console.log('🛑 扫描已停止，跳过剩余RSS源')
          break
        }
        try {
          const newArticlesCount = await this.processRSSFeed(
            url,
            previousScanTime
          )
          totalNewArticles += newArticlesCount

          // 避免请求过快
          await new Promise(resolve => setTimeout(resolve, 2000))
        } catch (error) {
          console.error(`❌ 处理RSS源失败 ${url}:`, error.message)
          await this.saveError(url, error)
        }
      }

      if (!this.isStop) {
        await this.saveData()
      }

      console.log(
        `✅ [${formatServerTime()}] RSS扫描完成，发现 ${totalNewArticles} 篇新文章`
      )

      // 显示内存使用情况
      this.showMemoryUsage()
    } catch (error) {
      console.error('❌ RSS扫描过程中发生错误:', error)
    } finally {
      this.isScanning = false
    }
  }

  // 获取 RSS 内容 (仅用于 /rss 查询)
  async getRSSContent(url) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'rss-worker.js'))

      const timeout = setTimeout(() => {
        worker.terminate()
        resolve({ success: false, error: '获取超时' })
      }, 30000)

      worker.postMessage({
        url,
        lastArticleId: null,
        lastArticlePubDate: null,
        lastScanTime: null
      })

      worker.on('message', result => {
        clearTimeout(timeout)
        worker.terminate()
        resolve(result)
      })

      worker.on('error', error => {
        clearTimeout(timeout)
        worker.terminate()
        resolve({ success: false, error: error.message })
      })
    })
  }

  // 处理单个RSS源
  async processRSSFeed(url, lastScanTime) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'rss-worker.js'))
      const lastArticleData = this.lastArticles.get(url)
      let lastArticleId = null
      let lastArticlePubDate = null

      // 兼容旧版：如果存的是字符串，则作为 ID，PubDate 为空
      if (typeof lastArticleData === 'string') {
        lastArticleId = lastArticleData
      } else if (lastArticleData && typeof lastArticleData === 'object') {
        lastArticleId = lastArticleData.id
        lastArticlePubDate = lastArticleData.pubDate
      }

      // 设置超时
      const timeout = setTimeout(() => {
        worker.terminate()
        reject(new Error('RSS获取超时'))
      }, 30000) // 30秒超时

      worker.postMessage({
        url,
        lastArticleId,
        lastArticlePubDate,
        lastScanTime
      })

      worker.on('message', async result => {
        clearTimeout(timeout)

        if (result.success) {
          try {
            const { newArticles, latestArticleId, latestArticlePubDate, feed } =
              result

            if (newArticles.length > 0) {
              console.log(
                `📰 发现 ${newArticles.length} 篇新文章来自: ${feed.title}`
              )

              // 记录最新文章ID和发布时间
              if (latestArticleId) {
                this.lastArticles.set(url, {
                  id: latestArticleId,
                  pubDate: latestArticlePubDate
                })
              }

              // 发送新文章到群组（按时间顺序，最新的在前面）
              for (const article of newArticles.reverse()) {
                if (this.isStop) {
                  console.log('🛑 扫描已停止，跳过剩余消息发送')
                  break
                }
                await this.sendToGroups(article, feed.title)
                this.stats.totalArticlesSent++

                // 避免发送过快
                await new Promise(resolve => setTimeout(resolve, 1500))
              }

              worker.terminate()
              resolve(newArticles.length)
            } else {
              console.log(
                `📰 [${formatServerTime()}] 没有新文章: ${feed.title}`
              )
              worker.terminate()
              resolve(0)
            }
          } catch (error) {
            worker.terminate()
            reject(error)
          }
        } else {
          worker.terminate()
          reject(new Error(result.error))
        }
      })

      worker.on('error', error => {
        clearTimeout(timeout)
        worker.terminate()
        reject(error)
      })

      worker.on('exit', code => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`Worker线程异常退出，代码: ${code}`))
        }
      })
    })
  }

  // 发送消息到所有群组
  async sendToGroups(article, feedTitle) {
    const title = cutTextByLength(article.title || '无标题', 200)
    const link = article.link || ''
    const contentSnippet = removeLineBreaks(article.contentSnippet || '')

    let message = `${feedTitle} 有新内容啦！！\n\n`
    message += `${title}\n\n`

    // if (pubDate) {
    //   message += `${pubDate}\n`
    // }

    if (contentSnippet) {
      message += `${cutTextByLength(contentSnippet, 200)}\n\n`
    }

    if (link) {
      message += `${link}`
    }

    for (const groupId of this.groupIds) {
      try {
        await this.bot.sendMessage(groupId, message, {
          disable_web_page_preview: false
        })
        console.log(`✅ 消息已发送到群组: ${groupId}`)
      } catch (error) {
        console.error(`❌ 发送消息到群组失败 ${groupId}:`, error.message)
      }
    }
  }

  // 检查消息是否艾特了机器人
  isBotMentioned(msg) {
    if (!msg || !msg.text || !this.botUsername) return false

    const mentionText = `@${this.botUsername}`.toLowerCase()
    if (!Array.isArray(msg.entities)) {
      return msg.text.toLowerCase().includes(mentionText)
    }

    return msg.entities.some(entity => {
      if (entity.type === 'mention') {
        const mention = msg.text
          .slice(entity.offset, entity.offset + entity.length)
          .toLowerCase()
        return mention === mentionText
      }
      if (entity.type === 'text_mention') {
        return !!this.botId && entity.user && entity.user.id === this.botId
      }
      return false
    })
  }

  // 提取艾特后面的提问内容
  extractMentionPrompt(msg) {
    if (!msg || !msg.text || !this.botUsername) return ''
    const mentionPattern = new RegExp(`@${this.botUsername}`, 'ig')
    return msg.text.replace(mentionPattern, '').trim()
  }

  // 调用 Ollama 聊天接口
  async chatWithOllama(prompt) {
    const endpoint = this.ollamaApiUrl.replace(/\/$/, '') + '/api/chat'
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.ollamaTimeoutMs)

    try {
      const messages = []
      if (this.ollamaSystemPrompt) {
        messages.push({
          role: 'system',
          content: this.ollamaSystemPrompt
        })
      }
      messages.push({ role: 'user', content: prompt })

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          stream: false,
          messages
        }),
        signal: controller.signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      const content = data && data.message ? data.message.content : ''
      if (!content) {
        throw new Error('Ollama 返回内容为空')
      }

      return content.trim()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // 处理群组内艾特聊天
  async handleMentionMessage(
    msg,
    promptOverride = '',
    skipMentionCheck = false
  ) {
    if (!this.ollamaEnabled) return
    if (!msg || !msg.chat || msg.chat.type === 'private') return
    if (!msg.text || msg.from?.is_bot) return

    const chatId = msg.chat.id.toString()
    if (!this.groupIds.includes(chatId)) return
    if (!skipMentionCheck && !this.isBotMentioned(msg)) return

    let prompt = (promptOverride || this.extractMentionPrompt(msg)).trim()
    if (!prompt) {
      await this.bot.sendMessage(
        msg.chat.id,
        '请在艾特我后面输入想聊的内容，例如：@机器人 介绍一下这篇文章',
        {
          reply_to_message_id: msg.message_id
        }
      )
      return
    }

    // 裁切提问内容，最多 300 字
    prompt = cutTextByLength(prompt, 300)

    await this.enqueueOllamaTask(msg, prompt)
  }

  // 加入 Ollama 串行队列（最多 50 个排队）
  async enqueueOllamaTask(msg, prompt) {
    if (this.ollamaQueue.length >= this.ollamaQueueMaxSize) {
      await this.bot.sendMessage(
        msg.chat.id,
        '⏳ 当前问答排队已满（50），请稍后再试。',
        {
          reply_to_message_id: msg.message_id
        }
      )
      return
    }

    this.ollamaQueue.push({ msg, prompt })
    const pendingCount =
      this.ollamaQueue.length + (this.isOllamaProcessing ? 1 : 0)

    if (pendingCount > 1) {
      await this.bot.sendMessage(
        msg.chat.id,
        `🕓 已加入问答队列，前面还有 ${pendingCount - 1} 个请求。`,
        {
          reply_to_message_id: msg.message_id
        }
      )
    }

    this.processOllamaQueue()
  }

  // 串行处理 Ollama 队列
  async processOllamaQueue() {
    if (this.isOllamaProcessing) return

    this.isOllamaProcessing = true
    console.log(
      `🧠 开始处理 Ollama 队列，当前待处理: ${this.ollamaQueue.length}`
    )

    try {
      while (this.ollamaQueue.length > 0 && !this.isStop) {
        const task = this.ollamaQueue.shift()
        const { msg, prompt } = task

        try {
          console.log(`💬 正在处理来自 ${msg.chat.id} 的提问...`)
          await this.bot.sendChatAction(msg.chat.id, 'typing')
          const answer = await this.chatWithOllama(prompt)
          await this.bot.sendMessage(
            msg.chat.id,
            cutTextByLength(answer, 3800),
            {
              reply_to_message_id: msg.message_id,
              disable_web_page_preview: true
            }
          )
        } catch (error) {
          console.error('❌ Ollama 聊天或发送失败:', error)
          // 避免将大量 HTML 或超长错误信息直接发送到 Telegram（会触发 ETELEGRAM: message is too long）
          let raw = error && error.message ? String(error.message) : '未知错误'
          // 如果是 HTML 响应，截取摘要并提示可能被 Cloudflare/防护拦截
          let safe = raw
          if (/<!doctype html>|<html\b/i.test(raw) || raw.length > 1200) {
            const statusMatch = raw.match(/^HTTP (\d+)/)
            const status = statusMatch ? statusMatch[1] : ''
            safe = status
              ? `HTTP ${status} 返回 HTML 页面或响应过长，已省略详细内容。`
              : '返回 HTML 页面或响应过长，已省略详细内容。'
          } else {
            safe = cutTextByLength(raw, 800)
          }

          try {
            await this.bot.sendMessage(msg.chat.id, `❌ 聊天失败：${safe}`, {
              reply_to_message_id: msg.message_id
            })
          } catch (sendError) {
            console.error('❌ 发送错误通知到 Telegram 失败:', sendError)
          }
        }

        // 每个任务之间增加 1 秒延迟，避免过快触发 API 限制
        if (this.ollamaQueue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }
    } catch (criticalError) {
      console.error('❌ Ollama 队列处理循环发生严重错误:', criticalError)
    } finally {
      this.isOllamaProcessing = false
      console.log('🧠 Ollama 队列处理结束')

      // 检查是否在处理过程中又有新任务进入，且当前循环已结束
      if (this.ollamaQueue.length > 0 && !this.isStop) {
        setTimeout(() => this.processOllamaQueue(), 500)
      }
    }
  }

  // 设置机器人命令
  setupBotCommands() {
    // 立即刷新指令
    this.bot.onText(/\/reflush/, async msg => {
      if (msg.chat.type === 'private') return // 忽略私聊

      const chatId = msg.chat.id
      const userId = msg.from.id

      try {
        if (!(await this.isAdmin(chatId, userId))) {
          await this.bot.sendMessage(
            chatId,
            '❌ 只有群主或管理员可以使用此指令'
          )
          return
        }

        if (this.isScanning) {
          await this.bot.sendMessage(chatId, '⏳ RSS扫描已经在进行中...')
          return
        }

        await this.bot.sendMessage(chatId, '🔍 正在立即刷新获取RSS...')
        await this.scanRSSFeeds()
        await this.bot.sendMessage(chatId, '✅ RSS刷新完成！')
      } catch (error) {
        console.error('❌ 指令处理失败:', error)
      }
    })

    // RSS 列表查询指令
    this.bot.onText(/\/rss\s+(.+)/, async (msg, match) => {
      if (msg.chat.type === 'private') return // 忽略私聊

      const chatId = msg.chat.id
      const userId = msg.from.id
      const domain = match[1].trim()

      try {
        if (!(await this.isAdmin(chatId, userId))) {
          await this.bot.sendMessage(
            chatId,
            '❌ 只有群主或管理员可以使用此指令'
          )
          return
        }

        const matchingUrls = this.rssUrls.filter(url => url.includes(domain))
        if (matchingUrls.length === 0) {
          await this.bot.sendMessage(
            chatId,
            `❌ 未能在配置中找到包含 "${domain}" 的 RSS 源`
          )
          return
        }

        await this.bot.sendMessage(
          chatId,
          `🔍 正在查询包含 "${domain}" 的 RSS 源，请稍候...`
        )

        for (const url of matchingUrls) {
          try {
            // 复用 Worker 获取内容 (传递 null 的 lastArticleId 以获取所有内容)
            const result = await this.getRSSContent(url)
            if (result.success) {
              const { feed } = result
              let message = `━━━━━━━━━━━━━━\n`
              message += `📖 *${feed.title || '未知 RSS 源'}*\n`
              message += `━━━━━━━━━━━━━━\n\n`

              // 确保按时间倒序排列（最新的在前面），并只取前 10 条
              const items = feed.items
                .sort((a, b) => {
                  const dateA = new Date(a.isoDate || a.pubDate || 0)
                  const dateB = new Date(b.isoDate || b.pubDate || 0)
                  return dateB - dateA
                })
                .slice(0, 10)

              items.forEach((item, index) => {
                const title = cutTextByLength(item.title || '无标题', 100)
                const link = item.link || ''
                const date = item.isoDate || item.pubDate
                const dateStr = date
                  ? formatServerTime(new Date(date)).split(' ')[0] // 只取日期部分使列表整洁
                  : '未知日期'

                message += `[${dateStr}] [${title}](${link})\n`
              })

              if (feed.items.length > 10) {
                message += `\n... 以及其他 ${feed.items.length - 10} 篇文章`
              }

              await this.bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
              })
            } else {
              await this.bot.sendMessage(
                chatId,
                `❌ 获取 RSS 源失败: ${url}\n原因: ${result.error}`
              )
            }
          } catch (error) {
            await this.bot.sendMessage(
              chatId,
              `❌ 处理 RSS 源时发生错误: ${url}\n${error.message}`
            )
          }
        }
      } catch (error) {
        console.error('❌ /rss 指令处理失败:', error)
      }
    })

    // 群组艾特聊天（按 Telegram message/entities 处理）
    this.bot.on('message', async msg => {
      try {
        await this.handleMentionMessage(msg)
      } catch (error) {
        console.error('❌ 艾特消息处理失败:', error)
      }
    })

    // 错误处理
    this.bot.on('polling_error', error => {
      console.error('❌ Telegram轮询错误:', error)
    })

    console.log('🎛️ 机器人命令设置完成')
  }

  // 启动定时任务
  startScheduler() {
    const intervalMs = this.scanInterval * 60 * 1000 // 转换为毫秒

    this.intervalId = setInterval(() => {
      console.log(`⏰ 定时扫描开始 - ${formatServerTime()}`)
      this.scanRSSFeeds()
    }, intervalMs)

    console.log(`⏰ 定时任务已启动，每 ${this.scanInterval} 分钟执行一次`)
  }

  // 停止定时任务
  stopScheduler() {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
      console.log('⏰ 定时任务已停止')
    }
  }

  // 优雅关闭
  async shutdown() {
    console.log('🛑 正在关闭机器人...')

    // 停止定时任务
    this.stopScheduler()

    this.isStop = true
    this.ollamaQueue = []

    // 等待当前扫描完成
    // while (this.isScanning) {
    //   console.log('⏳ 等待当前扫描完成...')
    //   await new Promise(resolve => setTimeout(resolve, 1000))
    // }

    // 停止机器人轮询
    await this.bot.stopPolling()

    // 保存数据
    await this.saveData()

    console.log('👋 机器人已关闭')
  }
}

// 启动机器人
const bot = new TelegramRSSBot()
bot.init()

// 优雅关闭
process.on('SIGINT', async () => {
  await bot.shutdown()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await bot.shutdown()
  process.exit(0)
})

module.exports = TelegramRSSBot
