const { parentPort } = require('worker_threads')
const Parser = require('rss-parser')

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'wikimoeTelegramPushBot/1.0'
  }
})

parentPort.on('message', async data => {
  const { url, lastArticleId, lastScanTime } = data

  try {
    console.log(`🧵 Worker正在获取: ${url}`)

    const feed = await parser.parseURL(url)
    const newArticles = []
    const lastScanDate = lastScanTime ? new Date(lastScanTime) : null

    // 查找新文章
    for (const item of feed.items) {
      const articleId = item.guid || item.link || item.title
      const itemDate = item.isoDate ? new Date(item.isoDate) : null

      // 如果有最后扫描时间，且文章时间早于或等于最后扫描时间，则不再视为新文章
      if (lastScanDate && itemDate && itemDate <= lastScanDate) {
        break
      }

      if (!lastArticleId || articleId !== lastArticleId) {
        newArticles.push(item)
      } else {
        break // 找到已知文章，停止搜索
      }
    }

    // 返回结果
    parentPort.postMessage({
      success: true,
      url,
      feed: {
        title: feed.title,
        items: feed.items
      },
      newArticles,
      latestArticleId: feed.items[0]
        ? feed.items[0].guid || feed.items[0].link || feed.items[0].title
        : null
    })
  } catch (error) {
    parentPort.postMessage({
      success: false,
      url,
      error: error.message
    })
  }
})
