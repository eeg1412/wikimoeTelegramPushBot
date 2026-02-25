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

// WMO 天气代码描述
const WMO_CODES = {
  0: '晴天',
  1: '大部晴朗',
  2: '局部多云',
  3: '阴天',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '中毛毛雨',
  55: '大毛毛雨',
  56: '冻雨(小)',
  57: '冻雨(大)',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨(小)',
  67: '冻雨(大)',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '中阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷雨夹小冰雹',
  99: '雷雨夹大冰雹'
}

// Ollama 工具定义
const OLLAMA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description:
        '根据城市名和国家代码查询天气，支持当前天气、历史天气和未来预报。' +
        '\n【使用规则】' +
        '\n1. 调用前需分析用户提到的地名所属国家，填写正确的 country_code 以避免同名城市歧义。' +
        '\n2. 查询类型由日期参数决定：' +
        '\n   • 当前天气：不指定任何日期参数' +
        '\n   • 未来预报：只指定 forecast_days（1-16整数）' +
        '\n   • 历史天气：必须同时指定 start_date 和 end_date' +
        '\n【日期要求（历史查询必读）】' +
        '\n• 日期格式必须为 YYYY-MM-DD（例：2024-03-01）' +
        '\n• 历史数据范围：1940-01-01 至昨天（今天及未来日期无历史数据）' +
        '\n• start_date 必须 <= end_date' +
        '\n• 时间跨度建议不超过 1 个月，过长会降低效率' +
        '\n【参数约束】' +
        '\n• 不能同时使用 forecast_days 与 start_date/end_date' +
        '\n• hourly/daily/current 参数可选，为空时使用默认字段' +
        '\n• 历史查询默认返回 hourly（小时）数据，包含 weathercode 用于天气描述',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '要查询天气的城市或地区名称，使用英文名称'
          },
          country_code: {
            type: 'string',
            description:
              'ISO 3166-1 alpha-2 国家/地区代码，如 CN、JP、US、GB、FR、DE 等，用于消除同名城市歧义'
          },
          start_date: {
            type: 'string',
            description:
              '开始日期 YYYY-MM-DD。查询历史天气时必须与 end_date 一起使用。范围：1940-01-01 至昨天。示例：2024-03-01'
          },
          end_date: {
            type: 'string',
            description:
              '结束日期 YYYY-MM-DD。必须 >= start_date。示例：2024-03-10'
          },
          forecast_days: {
            type: 'integer',
            description:
              '预报未来天数（1-16的整数）。仅用于预报查询，不能与 start_date/end_date 同时使用'
          },
          current: {
            type: 'array',
            items: { type: 'string' },
            description:
              '当前天气字段列表，如 ["temperature_2m","relativehumidity_2m","weathercode","windspeed_10m","apparent_temperature","precipitation"]。可选，为空时使用默认值'
          },
          hourly: {
            type: 'array',
            items: { type: 'string' },
            description:
              '每小时字段列表，如 ["temperature_2m","precipitation","weathercode","windspeed_10m"]。可选，为空时使用默认值。历史查询自动包含 weathercode'
          },
          daily: {
            type: 'array',
            items: { type: 'string' },
            description:
              '按天字段列表，如 ["temperature_2m_max","temperature_2m_min","weathercode","precipitation_sum","windspeed_10m_max","precipitation_probability_max"]。可选，为空时使用默认值'
          }
        },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_bangumi',
      description:
        '当用户提到作品名称时你必须先调用这个接口。会搜索动画、游戏、书籍、音乐等条目，获取条目列表和 ID。搜索完成后，必须从结果中选出最符合用户需求的一个条目，再调用 get_bangumi_subject 获取该条目的详细信息。',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: '搜索关键词，如作品名' },
          type: {
            type: 'integer',
            description:
              '条目类型：1=书籍/小说, 2=动画, 3=音乐, 4=游戏, 6=三次元；不填则搜索全部类型'
          }
        },
        required: ['keywords']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_bangumi_subject',
      description:
        '通过 subject_id 获取作品内容，请仅输出对应的原始作品内容。严禁输出任何推断、总结、评论。如果内容中不存在某项信息，请直接跳过，不得自行补全。最终回复格式是名称、开播日期简介的纯文本，不要包含任何多余的说明或格式。',
      parameters: {
        type: 'object',
        properties: {
          subject_id: {
            type: 'integer',
            description: '条目 ID，从 search_bangumi 的结果中获取'
          }
        },
        required: ['subject_id']
      }
    }
  }
]

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
      `${process.env.OLLAMA_SYSTEM_PROMPT} 当前时间：${new Date().toLocaleString()}` ||
      `你是一个有用的助手。当前时间：${new Date().toLocaleString()}`
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

  // ─── 工具执行：天气查询（内部自动地理编码）────────────────────────────────────
  async toolGetWeather(args) {
    const {
      city,
      country_code,
      start_date,
      end_date,
      forecast_days,
      current,
      hourly,
      daily
    } = args

    // 1. 地理编码：地名 → 经纬度
    const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search')
    geoUrl.searchParams.set('name', city)
    if (country_code)
      geoUrl.searchParams.set('country_code', country_code.toUpperCase())
    geoUrl.searchParams.set('count', '1')
    geoUrl.searchParams.set('language', 'zh')
    geoUrl.searchParams.set('format', 'json')
    const geoResp = await fetch(geoUrl.toString())
    if (!geoResp.ok) throw new Error(`地理编码失败 HTTP ${geoResp.status}`)
    const geoData = await geoResp.json()
    if (!geoData.results || geoData.results.length === 0) {
      throw new Error(
        `未找到「${city}${country_code ? ' (' + country_code.toUpperCase() + ')' : ''}」对应的坐标`
      )
    }
    const geo = geoData.results[0]
    const {
      latitude,
      longitude,
      timezone = 'auto',
      name,
      admin1,
      country
    } = geo
    const locationLabel = [name, admin1, country].filter(Boolean).join(', ')

    // 2. 天气查询
    const today = new Date().toISOString().slice(0, 10)
    const isHistory = start_date && start_date < today

    // 3. 历史数据相关验证
    if (isHistory) {
      // 历史查询必须同时有 start_date 和 end_date
      if (!start_date || !end_date) {
        throw new Error(
          '历史天气查询必须同时指定 start_date 和 end_date（格式：YYYY-MM-DD）'
        )
      }

      // 验证日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/
      if (!dateRegex.test(start_date) || !dateRegex.test(end_date)) {
        throw new Error('日期格式必须为 YYYY-MM-DD，例如：2024-03-01')
      }

      // 验证日期逻辑
      if (start_date > end_date) {
        throw new Error('start_date 不能大于 end_date')
      }

      // 验证数据范围（Open-Meteo 历史数据通常从 1940 年开始）
      if (start_date < '1940-01-01') {
        throw new Error(
          'Open-Meteo 历史数据通常从 1940 年开始，请选择 1940 年之后的日期'
        )
      }

      // 验证不能查询未来日期
      if (start_date >= today) {
        throw new Error('不能查询未来或当前日期的历史数据，请选择过去的日期')
      }
    }

    const baseUrl = isHistory
      ? 'https://archive-api.open-meteo.com/v1/archive'
      : 'https://api.open-meteo.com/v1/forecast'

    const url = new URL(baseUrl)
    url.searchParams.set('latitude', latitude)
    url.searchParams.set('longitude', longitude)
    url.searchParams.set('timezone', timezone || 'auto')
    if (start_date) url.searchParams.set('start_date', start_date)
    if (end_date) url.searchParams.set('end_date', end_date)
    if (forecast_days && !start_date)
      url.searchParams.set('forecast_days', forecast_days)

    // 处理数据字段参数
    let hasFields =
      (current && current.length > 0) ||
      (hourly && hourly.length > 0) ||
      (daily && daily.length > 0)

    // 若 AI 未指定任何数据字段，使用默认参数
    if (!hasFields) {
      if (isHistory) {
        // 历史数据：返回 hourly 数据（包含 weathercode 以获取天气描述）
        url.searchParams.set(
          'hourly',
          'temperature_2m,precipitation,weathercode'
        )
      } else {
        // 当前或预报：使用 current_weather
        url.searchParams.set('current_weather', 'true')
      }
    } else {
      // AI 指定了字段，按其指定的参数添加
      if (current && current.length > 0)
        url.searchParams.set('current', current.join(','))
      if (hourly && hourly.length > 0)
        url.searchParams.set('hourly', hourly.join(','))
      if (daily && daily.length > 0)
        url.searchParams.set('daily', daily.join(','))
    }

    const resp = await fetch(url.toString())
    if (!resp.ok) throw new Error(`天气查询失败 HTTP ${resp.status}`)
    const weatherData = await resp.json()

    return { locationLabel, weatherData }
  }

  // ─── 工具执行：Bangumi 搜索 ───────────────────────────────────────────────────
  async toolSearchBangumi({ keywords, type }) {
    const url = new URL(
      `https://api.bgm.tv/search/subject/${encodeURIComponent(keywords)}`
    )
    url.searchParams.set('responseGroup', 'small')
    url.searchParams.set('max_results', '5')
    if (type) url.searchParams.set('type', type)
    const resp = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'wikimoeTelegramBot/1.0 (https://github.com/wikimoe)'
      }
    })
    if (!resp.ok) throw new Error(`Bangumi 搜索失败 HTTP ${resp.status}`)
    return await resp.json()
  }

  // ─── 工具执行：Bangumi 条目详情 ───────────────────────────────────────────────
  async toolGetBangumiSubject({ subject_id }) {
    const resp = await fetch(`https://api.bgm.tv/v0/subjects/${subject_id}`, {
      headers: {
        'User-Agent': 'wikimoeTelegramBot/1.0 (https://github.com/wikimoe)'
      }
    })
    if (!resp.ok) throw new Error(`Bangumi 条目获取失败 HTTP ${resp.status}`)
    return await resp.json()
  }

  // ─── 执行单个工具调用 ─────────────────────────────────────────────────────────
  async executeTool(name, args) {
    console.log(`🔧 执行工具: ${name}`, JSON.stringify(args))
    switch (name) {
      case 'get_weather':
        return await this.toolGetWeather(args)
      case 'search_bangumi':
        return await this.toolSearchBangumi(args)
      case 'get_bangumi_subject':
        return await this.toolGetBangumiSubject(args)
      default:
        throw new Error(`未知工具: ${name}`)
    }
  }

  // ─── 格式化天气结果 ───────────────────────────────────────────────────────────
  formatWeatherData(weatherData, locationLabel) {
    const lines = []
    const wmo = code => WMO_CODES[code] ?? `天气代码 ${code}`
    const degToDir = deg => {
      const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
      return dirs[Math.round(deg / 45) % 8]
    }
    // 将 API 返回的 "2025-07-10T12:00" 格式化为 "2025-07-10 12:00"
    const fmtTime = t => (t ? String(t).replace('T', ' ') : t)

    const loc = locationLabel ? `📍 ${locationLabel}` : ''
    if (loc) lines.push(loc)
    if (weatherData.timezone) lines.push(`🕐 时区：${weatherData.timezone}`)
    lines.push('')

    // current_weather=true 返回的简化当前天气对象
    if (weatherData.current_weather) {
      const c = weatherData.current_weather
      lines.push('*📊 当前天气*')
      if (c.time !== undefined) lines.push(`🕐 时间：${fmtTime(c.time)}`)
      if (c.temperature !== undefined)
        lines.push(`🌡️ 气温：${c.temperature} °C`)
      if (c.weathercode !== undefined)
        lines.push(`🌤 天气：${wmo(c.weathercode)}`)
      if (c.windspeed !== undefined) lines.push(`💨 风速：${c.windspeed} km/h`)
      if (c.winddirection !== undefined)
        lines.push(
          `🧭 风向：${degToDir(c.winddirection)}（${c.winddirection}°）`
        )
      if (c.is_day !== undefined)
        lines.push(`☀️ 昼夜：${c.is_day ? '白天' : '夜间'}`)
      lines.push('')
    }

    // current=[...] 返回的详细当前天气对象
    if (weatherData.current) {
      const c = weatherData.current
      lines.push('*📊 当前天气*')
      if (c.time !== undefined) lines.push(`🕐 时间：${fmtTime(c.time)}`)
      if (c.temperature_2m !== undefined)
        lines.push(`🌡️ 气温：${c.temperature_2m} °C`)
      if (c.apparent_temperature !== undefined)
        lines.push(`🌡️ 体感：${c.apparent_temperature} °C`)
      if (c.weathercode !== undefined)
        lines.push(`🌤 天气：${wmo(c.weathercode)}`)
      if (c.weather_code !== undefined)
        lines.push(`🌤 天气：${wmo(c.weather_code)}`)
      if (c.relative_humidity_2m !== undefined)
        lines.push(`💧 湿度：${c.relative_humidity_2m} %`)
      if (c.relativehumidity_2m !== undefined)
        lines.push(`💧 湿度：${c.relativehumidity_2m} %`)
      if (c.windspeed_10m !== undefined)
        lines.push(`💨 风速：${c.windspeed_10m} km/h`)
      if (c.wind_speed_10m !== undefined)
        lines.push(`💨 风速：${c.wind_speed_10m} km/h`)
      if (c.wind_direction_10m !== undefined)
        lines.push(
          `🧭 风向：${degToDir(c.wind_direction_10m)}（${c.wind_direction_10m}°）`
        )
      if (c.precipitation !== undefined)
        lines.push(`🌧 降水：${c.precipitation} mm`)
      if (c.is_day !== undefined)
        lines.push(`☀️ 昼夜：${c.is_day ? '白天' : '夜间'}`)
      lines.push('')
    }

    // 按天数据
    if (weatherData.daily) {
      const d = weatherData.daily
      const times = d.time || []
      if (times.length > 0) {
        lines.push('*📅 逐日天气*')
        times.forEach((date, i) => {
          const parts = [`📆 ${date}`]
          if (d.weathercode?.[i] !== undefined)
            parts.push(`${wmo(d.weathercode[i])}`)
          if (d.temperature_2m_max?.[i] !== undefined)
            parts.push(`↑${d.temperature_2m_max[i]}°C`)
          if (d.temperature_2m_min?.[i] !== undefined)
            parts.push(`↓${d.temperature_2m_min[i]}°C`)
          if (d.precipitation_sum?.[i] !== undefined)
            parts.push(`🌧${d.precipitation_sum[i]}mm`)
          if (d.precipitation_probability_max?.[i] !== undefined)
            parts.push(`降水概率${d.precipitation_probability_max[i]}%`)
          if (d.windspeed_10m_max?.[i] !== undefined)
            parts.push(`💨${d.windspeed_10m_max[i]}km/h`)
          lines.push(parts.join('  '))
        })
        lines.push('')
      }
    }

    // 逐小时（最多显示 24 小时）
    if (weatherData.hourly) {
      const h = weatherData.hourly
      const times = (h.time || []).slice(0, 24)
      if (times.length > 0) {
        lines.push('*⏱ 逐小时天气（前24小时）*')
        let currentDate = ''
        times.forEach((t, i) => {
          const fullTime = fmtTime(t)
          const dateOnly = fullTime.slice(0, 10)
          const timeOnly = fullTime.slice(11, 16)

          // 当日期变化时，显示新的日期标题
          if (dateOnly !== currentDate) {
            currentDate = dateOnly
            lines.push(`📅 ${dateOnly}`)
          }

          const parts = [`🕐 ${timeOnly}`]
          if (h.weathercode?.[i] !== undefined)
            parts.push(wmo(h.weathercode[i]))
          if (h.temperature_2m?.[i] !== undefined)
            parts.push(`${h.temperature_2m[i]}°C`)
          if (h.precipitation?.[i] !== undefined)
            parts.push(`🌧${h.precipitation[i]}mm`)
          if (h.windspeed_10m?.[i] !== undefined)
            parts.push(`💨${h.windspeed_10m[i]}km/h`)
          lines.push(parts.join('  '))
        })
        lines.push('')
      }
    }

    // 尾部数据来源
    lines.push('_数据来源：Open-Meteo_')
    return lines.join('\n').trim()
  }

  // ─── 格式化 Bangumi 搜索结果 ─────────────────────────────────────────────────
  formatBangumiSearch(data) {
    const list = data.list || data.results || []
    if (list.length === 0) return '未找到相关条目。'
    const typeMap = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' }
    const lines = ['*🔍 Bangumi 搜索结果*', '']
    list.slice(0, 5).forEach((item, i) => {
      const type = typeMap[item.type] ?? '未知'
      const score = item.rating?.score ? `⭐ ${item.rating.score}` : ''
      const year = item.air_date ? item.air_date.slice(0, 4) : ''
      lines.push(
        `${i + 1}. *${item.name_cn || item.name}* (${type}${year ? ' · ' + year : ''}) ${score}`
      )
      if (item.name_cn && item.name && item.name_cn !== item.name)
        lines.push(`   原名：${item.name}`)
      if (item.summary)
        lines.push(`   ${cutTextByLength(removeLineBreaks(item.summary), 80)}`)
      lines.push(`   🔗 https://bgm.tv/subject/${item.id}`)
      lines.push('')
    })
    lines.push('_数据来源：Bangumi.tv_')
    return lines.join('\n').trim()
  }

  // ─── 格式化 Bangumi 条目详情 ─────────────────────────────────────────────────
  formatBangumiSubject(data) {
    if (!data || !data.id) return '未找到该条目信息。'
    const typeMap = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' }
    const lines = []
    const title = data.name_cn || data.name
    lines.push(`*📺 ${title}*`)
    if (title !== data.name) lines.push(`原名：${data.name}`)
    lines.push('')
    if (data.type) lines.push(`类型：${typeMap[data.type] ?? data.type}`)
    if (data.air_date) lines.push(`放送日期：${data.air_date}`)
    if (data.total_episodes) lines.push(`总集数：${data.total_episodes}`)
    if (data.rating?.score)
      lines.push(`评分：⭐ ${data.rating.score}（${data.rating.total} 人评价）`)
    if (data.rank) lines.push(`排名：#${data.rank}`)
    if (data.platform) lines.push(`平台：${data.platform}`)
    lines.push('')
    if (data.summary) {
      lines.push('*📝 简介*')
      lines.push(cutTextByLength(data.summary, 300))
      lines.push('')
    }
    if (data.tags && data.tags.length > 0) {
      lines.push(
        `🏷 标签：${data.tags
          .slice(0, 8)
          .map(t => t.name)
          .join(' · ')}`
      )
      lines.push('')
    }
    lines.push(`🔗 https://bgm.tv/subject/${data.id}`)
    lines.push('_数据来源：Bangumi.tv_')
    return lines.join('\n').trim()
  }

  // ─── 将天气工具结果转换为最终发送给用户的文本（仅天气，bangumi 由 AI 总结）────────
  formatToolResults(toolResults) {
    const sections = []

    for (const { toolName, result } of toolResults) {
      if (toolName === 'get_weather' && result && result.weatherData) {
        sections.push(
          this.formatWeatherData(result.weatherData, result.locationLabel)
        )
      }
    }

    return sections.length > 0
      ? sections.join('\n\n─────────────────\n\n')
      : null
  }

  // ─── 调用 Ollama 聊天接口（支持工具调用）────────────────────────────────────────
  // msg: 可选，传入原始 Telegram 消息对象，用于发送工具调用通知
  async chatWithOllama(prompt, msg = null) {
    const endpoint = this.ollamaApiUrl.replace(/\/$/, '') + '/api/chat'
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.ollamaTimeoutMs)

    const messages = []
    if (this.ollamaSystemPrompt) {
      messages.push({ role: 'system', content: this.ollamaSystemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    // 工具名 → 友好通知文案
    const TOOL_NOTICES = {
      get_weather: '🌤 正在查询天气数据...',
      search_bangumi: '🔍 正在搜索 相关条目...',
      get_bangumi_subject: '📖 正在获取 条目详情...'
    }

    // 天气工具：由本程序格式化；其余工具（bangumi）：将真实数据回传给 AI 让其总结
    const SELF_FORMATTED_TOOLS = new Set(['get_weather'])

    // 收集天气工具执行结果，供本程序格式化输出
    const weatherToolResults = []
    // 标记是否有 bangumi 相关工具被调用
    let hasBangumiTool = false

    // 发送 Telegram 通知的辅助方法
    const sendNotice = async text => {
      if (!msg) return
      try {
        await this.bot.sendMessage(msg.chat.id, text, {
          reply_to_message_id: msg.message_id
        })
      } catch (e) {
        console.error('❌ 发送工具通知失败:', e.message)
      }
    }

    try {
      for (let round = 0; round < 10; round++) {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.ollamaModel,
            stream: false,
            messages,
            tools: OLLAMA_TOOLS
          }),
          signal: controller.signal
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`HTTP ${response.status}: ${errorText}`)
        }

        const data = await response.json()
        const assistantMessage = data && data.message ? data.message : null
        if (!assistantMessage) throw new Error('Ollama 返回内容为空')

        // 将 assistant 消息加入历史（不管有无 tool_calls）
        messages.push(assistantMessage)

        // 没有工具调用了，退出循环
        const toolCalls = assistantMessage.tool_calls
        if (!toolCalls || toolCalls.length === 0) break

        // 依次执行工具调用
        for (const toolCall of toolCalls) {
          const toolName = toolCall.function?.name
          let toolArgs = toolCall.function?.arguments ?? {}
          // Ollama 某些版本返回 string，需要 parse
          if (typeof toolArgs === 'string') {
            try {
              toolArgs = JSON.parse(toolArgs)
            } catch {
              toolArgs = {}
            }
          }

          // 发送 Telegram 通知，告知用户正在调用哪个接口
          const notice = TOOL_NOTICES[toolName]
          if (notice) await sendNotice(notice)

          let result
          let toolError = null
          try {
            result = await this.executeTool(toolName, toolArgs)
          } catch (toolErr) {
            console.error(`❌ 工具 ${toolName} 执行失败:`, toolErr)
            toolError = toolErr.message
            result = { error: toolErr.message }
          }

          if (toolError) {
            // 工具出错：仅将错误信息（含 HTTP 状态）回传给 AI，让 AI 告知用户
            messages.push({
              role: 'tool',
              content: JSON.stringify({ error: toolError })
            })
          } else if (SELF_FORMATTED_TOOLS.has(toolName)) {
            // 天气：收集结果，不回传给 AI，告知 AI "OK" 即可
            weatherToolResults.push({ toolName, toolArgs, result })
            messages.push({ role: 'tool', content: 'OK' })
          } else if (toolName === 'search_bangumi') {
            // Bangumi 搜索：提取 list 中的 type/name/id，拼接成 markdown 列表
            hasBangumiTool = true
            const typeMap = {
              1: '书籍',
              2: '动画',
              3: '音乐',
              4: '游戏',
              6: '三次元'
            }
            const list = result.list || result.results || []
            const listStr = list
              .map(
                item =>
                  `- ${item.name_cn || item.name || '未知'}（${typeMap[item.type] || '未知'}） - ID:${item.id}`
              )
              .join('\n')
            const contentStr = listStr || '未找到相关结果'
            messages.push({ role: 'tool', content: contentStr })
          } else if (toolName === 'get_bangumi_subject') {
            // Bangumi 详情：提取关键字段（名字、开播日、简介），拼接成可读字符串传给 AI
            hasBangumiTool = true
            const name = result.name_cn || result.name || '未知'
            const airDate = result.air_date || result.date || '未知'
            const summary = result.summary || '无简介'
            const contentStr = `《${name}》（开播日期：${airDate}）\n简介：${summary}`
            messages.push({ role: 'tool', content: contentStr })
          } else {
            // 其他工具：将 JSON 回传给 AI
            hasBangumiTool = true
            messages.push({
              role: 'tool',
              content: JSON.stringify(result)
            })
          }
        }
      }

      // 如果有天气结果，用本程序格式化后直接返回
      if (weatherToolResults.length > 0) {
        const formatted = this.formatToolResults(weatherToolResults)
        if (formatted) return { type: 'tool', text: formatted }
      }

      // bangumi 或纯文本：返回 AI 最终文字回复
      const lastAssistant = [...messages]
        .reverse()
        .find(m => m.role === 'assistant')
      const content = lastAssistant?.content || ''
      if (!content) throw new Error('Ollama 返回内容为空')
      return { type: hasBangumiTool ? 'tool' : 'text', text: content.trim() }
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

    // 检查是否艾特了机器人或者回复了机器人的消息
    const isBotMentioned = this.isBotMentioned(msg)
    const isReplyToBot =
      msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.id === this.botId

    if (!skipMentionCheck && !isBotMentioned && !isReplyToBot) return

    let userPrompt = (promptOverride || this.extractMentionPrompt(msg)).trim()
    let finalPrompt = userPrompt

    // 如果是回复机器人的消息，把被引用的内容带上
    if (
      isReplyToBot &&
      (msg.reply_to_message.text || msg.reply_to_message.caption)
    ) {
      const quotedText =
        msg.reply_to_message.text || msg.reply_to_message.caption
      // 构造一个新的 prompt，包含引用内容和用户回复
      finalPrompt = `【引用内容】：\n${quotedText}\n\n【用户回复】：\n${
        userPrompt || '请根据引用内容回复。'
      }`
    }

    if (!finalPrompt && !isReplyToBot) {
      await this.bot.sendMessage(
        msg.chat.id,
        '请在艾特我后面输入想聊的内容，或者直接回复我的消息，例如：@机器人 帮助我总结一下以上内容',
        {
          reply_to_message_id: msg.message_id
        }
      )
      return
    }

    // 裁切提问内容，最多 1500 字（包含引用后适当增加上限）
    finalPrompt = cutTextByLength(finalPrompt, 1500)

    await this.enqueueOllamaTask(msg, finalPrompt)
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
          const result = await this.chatWithOllama(prompt, msg)
          const replyText = typeof result === 'object' ? result.text : result
          await this.bot.sendMessage(
            msg.chat.id,
            cutTextByLength(replyText, 3800),
            {
              reply_to_message_id: msg.message_id,
              disable_web_page_preview: true,
              parse_mode: 'Markdown'
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
