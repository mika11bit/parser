const puppeteer = require('puppeteer')
const XLSX = require('xlsx')

// Функція для затримки
function delay(time) {
	return new Promise(function (resolve) {
		setTimeout(resolve, time)
	})
}

async function clearBrowserData(browser) {
	const pages = await browser.pages()
	const client = await pages[0].target().createCDPSession()
	await client.send('Network.clearBrowserCookies')
	await client.send('Network.clearBrowserCache')
	await client.send('Storage.clearDataForOrigin', {
		origin: '*',
		storageTypes: 'all',
	})
}

async function gotoWithRetries(page, url, options, retries = 3) {
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			await page.goto(url, options)
			return
		} catch (error) {
			console.log(
				`Помилка при завантаженні сторінки ${url}: ${error.message}. Спроба ${
					attempt + 1
				} з ${retries}.`,
			)
			if (attempt < retries - 1) {
				await delay(5000) // Чекаємо 5 секунд перед повторною спробою
			} else {
				throw error
			}
		}
	}
}

;(async () => {
	try {
		const browser = await puppeteer.launch({ headless: false })
		const page = await browser.newPage()

		// Відкриваємо початкову сторінку з параметром size=10000
		await gotoWithRetries(
			page,
			'https://euipo.europa.eu/ec2/search/find?language=ru&text=&niceClass=&size=10&page=1&officeList=RU&searchMode=WORDSPREFIX&sortBy=relevance',
			{ waitUntil: 'networkidle2', timeout: 0 },
		)
		console.log('Відкрито початкову сторінку.')

		// Очікуємо завантаження необхідного елементу
		await page.waitForSelector('tbody tr')
		console.log('Основний контент завантажено.')

		// Отримуємо всі рядки з таблиці
		const rows = await page.$$('tbody tr')
		console.log(`Знайдено ${rows.length} рядків.`)

		// Масив для збереження результатів
		const results = []

		// Перебираємо рядки і клікаємо на посилання для відкриття сторінки
		for (let i = 0; i < rows.length; i++) {
			if (i > 0 && i % 400 === 0) {
				console.log('Робимо паузу на 1 хвилину після 400 рядків.')
				await delay(60000) // Чекаємо 1 хвилину
			}

			// Очищення даних браузера перед кожним запитом
			await clearBrowserData(browser)

			const termDetailsLink = await rows[i].$('td.termDetails a')

			if (termDetailsLink) {
				const href = await page.evaluate(
					a => a.getAttribute('href'),
					termDetailsLink,
				)
				const termPageUrl = `https://euipo.europa.eu${href}`

				// Відкриваємо нову сторінку
				const termPage = await browser.newPage()
				try {
					await gotoWithRetries(termPage, termPageUrl, {
						waitUntil: 'networkidle2',
						timeout: 0,
					})
					console.log(`Сторінка для рядка ${i + 1} завантажена.`)

					// Витягуємо дані rus
					const rusElement = await termPage.$('.span10.english_master_title h4')
					const rusText = rusElement
						? await termPage.evaluate(el => el.textContent.trim(), rusElement)
						: 'Не знайдено rus тексту'

					// Витягуємо дані en і pl з таблиці
					const detailsRows = await termPage.$$('.detailsTable tr')

					let enText = 'Не знайдено en тексту'
					let plText = 'Не знайдено pl тексту'

					for (const row of detailsRows) {
						const cells = await row.$$('td')
						if (cells.length > 3) {
							const lang = await termPage.evaluate(
								cell => cell.textContent.trim(),
								cells[0],
							)
							const term = await termPage.evaluate(
								cell => cell.textContent.trim(),
								cells[2],
							)

							if (lang === 'en') {
								enText = term
							} else if (lang === 'pl') {
								plText = term
							}
						}
					}

					// Додаємо результати до масиву
					results.push({ rus: rusText, en: enText, pl: plText })
					console.log(`Результати для рядка ${i + 1} додано.`)
				} catch (error) {
					console.log(
						`Не вдалося завантажити сторінку для рядка ${
							i + 1
						}: ${termPageUrl}. Помилка: ${error.message}`,
					)
				} finally {
					// Закриваємо сторінку
					await termPage.close()
					console.log(`Сторінка для рядка ${i + 1} закрита.`)
				}

				// Повертаємося до початкової сторінки
				await page.bringToFront()

				// Додаємо затримку між запитами
				await delay(5000) // Чекаємо 5 секунд перед наступним запитом
			} else {
				console.log(
					`Посилання на деталі терміну для рядка ${i + 1} не знайдено.`,
				)
			}
		}

		// Виводимо результати
		console.log('Всі результати:', results)

		// Створюємо нову книгу Excel
		const workbook = XLSX.utils.book_new()

		// Перетворюємо масив об'єктів на лист
		const worksheet = XLSX.utils.json_to_sheet(results)

		// Додаємо лист до книги
		XLSX.utils.book_append_sheet(workbook, worksheet, 'Results')

		// Записуємо книгу у файл
		XLSX.writeFile(workbook, 'results.xlsx')
		console.log('Результати записано до файлу results.xlsx')

		await browser.close()
	} catch (error) {
		console.log(`Виникла помилка: ${error.message}`)
	}
})()
