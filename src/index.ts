import axios from 'axios'
import cheerio from 'cheerio'
import { Telegraf } from 'telegraf'
import sqlite3 from 'sqlite3'
import * as env from 'dotenv'

env.config()

let delayTime = Number(process.env.INTERVAL_DELAY) || 60000 // Default delay is 1 minute
const db = new sqlite3.Database('freelanceBot.db')

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    views TEXT,
    publishedAt TEXT,
    price TEXT,
    href TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId INTEGER UNIQUE,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS views_stat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    count INTEGER
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS responses_stat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    count INTEGER
  )`)
})

async function getFreelanceHabrPage() {
  const url = 'http://freelance.habr.com/tasks'
  const response = await axios.get(url)
  return response.data
}

async function parseTasks() {
  const html = await getFreelanceHabrPage()
  const $ = cheerio.load(html)

  const tasks = $('article.task').slice(0, 5)

  const parsedTasks = tasks
    .map((index, task) => {
      const title = $(task).find('.task__title a').text().trim()
      const views = $(task).find('.params__count').text().trim()
      const publishedAt = $(task)
        .find('.params__published-at span')
        .text()
        .trim()
      const price = $(task).find('.count').text().trim()
      const href = $(task).find('a').attr('href')

      return { title, views, publishedAt, price, href }
    })
    .get()

  return parsedTasks
}

async function saveOrUpdateToDatabase(task: any) {
  return new Promise<void>((resolve, reject) => {
    db.get(
      'SELECT * FROM tasks WHERE title = ?',
      [task.title],
      (err, existingTask) => {
        const existingTasks = existingTask as { id: number }
        if (err) {
          reject(err)
        } else if (existingTask) {
          // Проект уже существует, обновляем данные
          const stmt = db.prepare(`
          UPDATE tasks 
          SET views = ?, publishedAt = ?, price = ?, href = ?, timestamp = CURRENT_TIMESTAMP 
          WHERE id = ?`)
          stmt.run(
            task.views,
            task.publishedAt,
            task.price,
            task.href,
            existingTasks.id,
            (updateErr: any) => {
              stmt.finalize()
              if (updateErr) {
                reject(updateErr)
              } else {
                resolve()
              }
            }
          )
        } else {
          // Проект не существует, добавляем новую запись
          const stmt = db.prepare(`
          INSERT INTO tasks (title, views, publishedAt, price, href) 
          VALUES (?, ?, ?, ?, ?)`)
          stmt.run(
            task.title,
            task.views,
            task.publishedAt,
            task.price,
            task.href,
            (insertErr: any) => {
              stmt.finalize()
              if (insertErr) {
                reject(insertErr)
              } else {
                resolve()
              }
            }
          )
        }
      }
    )
  })
}

async function updateAndSendMessages(bot: any, chatId: number) {
  const tasks = await parseTasks()

  // Сохранение данных в базу данных
  await Promise.all(tasks.map((task) => saveOrUpdateToDatabase(task)))

  // Получение данных из базы данных
  const latestTasks = await getFromDatabase()

  // Формирование сообщения
  const message = `<b>Top 5 Tasks:</b>\n\n${latestTasks
    .map((task) => {
      return `<b>Title:</b> <a href="http://freelance.habr.com/${task.href}">${task.title}</a>\n<b>Views:</b> ${task.views}\n<b>Published At:</b> ${task.publishedAt}\n<b>Price:</b> ${task.price}\n\n`
    })
    .join('')}`

  // Получение последнего сообщения в чате
  await bot.telegram.sendMessage(chatId, message, {
    parse_mode: 'HTML',
  })
}

// Функция для получения списка чатов, которые уже сохранены в базе данных
async function getSavedChatsFromDatabase() {
  return new Promise<number[]>((resolve, reject) => {
    db.all('SELECT chatId FROM chats', (err, rows) => {
      if (err) {
        reject(err)
      } else {
        const savedChats = rows.map((row) => (row as { chatId: number }).chatId)
        resolve(savedChats)
      }
    })
  })
}

// Функция для сохранения новых чатов в базу данных
async function saveChatsToDatabase(chats: any[]) {
  const stmt = db.prepare('INSERT INTO chats (chatId) VALUES (?)')

  chats.forEach((chat) => {
    stmt.run(chat.chat.id)
  })

  stmt.finalize()
}

async function getFromDatabase() {
  return new Promise<any[]>((resolve, reject) => {
    db.all(
      'SELECT * FROM tasks ORDER BY timestamp DESC LIMIT 5',
      (err, rows) => {
        if (err) {
          reject(err)
        } else {
          resolve(rows)
        }
      }
    )
  })
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '')

const getDelay = () => {
  console.log(delayTime)

  return Number(delayTime)
}

const loop = async () => {
  try {
    // Получение всех чатов, в которых участвует бот ( сохраненые в базе данных )
    const savedChats = await getSavedChatsFromDatabase()

    // Отправка сообщения в каждый чат
    for (const chatId of savedChats) {
      await updateAndSendMessages(bot, chatId)
    }
  } catch (error) {
    console.error('Error while processing timer event:', error)
  }
  //wait getDelay()
  setTimeout(loop, getDelay())
}

// Обработчик события таймера
// setInterval(async () => {

// }, getDelay()) // Отправка каждую минуту
loop()
// Обработчик события текстовых сообщений
bot.on('text', async (ctx) => {
  try {
    // При написании любого текста в бот, сохранять его id в базу данных
    const chatId = ctx.chat.id

    const newDelay = Number(ctx.message.text)
    console.log(newDelay)

    if (!isNaN(newDelay)) {
      //   process.env.INTERVAL_DELAY = String(newDelay)
      delayTime = Number(newDelay)
      console.log(newDelay)
    }

    await saveChatToDatabase(chatId)
  } catch (error) {
    console.error('Error while processing text event:', error)
  }
})

// Функция для сохранения чата в базе данных
async function saveChatToDatabase(chatId: number) {
  return new Promise<void>((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO chats (chatId) VALUES (?)',
      [chatId],
      (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
    )
  })
}

// Запуск бота
bot.launch()
