const { parentPort } = require('worker_threads')
const Parser = require('rss-parser')

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'wikimoeTelegramPushBot/1.0'
  }
})

parentPort.on('message', async data => {
  const { url, lastArticleId, lastArticlePubDate, lastScanTime } = data

  try {
    console.log(`🧵 Worker正在获取: ${url}`)

    const feed = await parser.parseURL(url)
    const newArticles = []
    const lastPubDate = lastArticlePubDate ? new Date(lastArticlePubDate) : null
    const lastScanDate = lastScanTime ? new Date(lastScanTime) : null

    // 查找新文章
    for (const item of feed.items) {
      const articleId = item.guid || item.link || item.title
      const itemDate = item.isoDate ? new Date(item.isoDate) : null

      if (lastPubDate) {
        // 新版逻辑：判断依据改为记录在该 RSS 源最新文章发布时间之后的文章且 URL 不是记录的 URL
        if (itemDate && itemDate > lastPubDate && articleId !== lastArticleId) {
          newArticles.push(item)
        } else if (
          articleId === lastArticleId ||
          (itemDate && itemDate <= lastPubDate)
        ) {
          // 找到已知文章或比已知最晚时间更早的文章，停止搜寻
          break
        }
      } else {
        // 旧版兼容逻辑：旧版只记录了 URL，此时按照现有逻辑根据 lastScanTime 判断新的文章
        if (lastScanDate && itemDate && itemDate <= lastScanDate) {
          break
        }

        if (!lastArticleId || articleId !== lastArticleId) {
          newArticles.push(item)
        } else {
          break // 找到已知文章，停止搜索
        }
      }
    }

    // 获取最新一篇文章的信息供记录
    const latestItem = feed.items[0]
    let latestArticleId = null
    let latestArticlePubDate = null

    if (latestItem) {
      latestArticleId = latestItem.guid || latestItem.link || latestItem.title
      const pubDate = latestItem.isoDate
        ? new Date(latestItem.isoDate)
        : new Date()
      // 如果发布时间超过系统当前时间则替换为系统当前时间
      const now = new Date()
      latestArticlePubDate = (pubDate > now ? now : pubDate).toISOString()
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
      latestArticleId,
      latestArticlePubDate
    })
  } catch (error) {
    parentPort.postMessage({
      success: false,
      url,
      error: error.message
    })
  }
})
