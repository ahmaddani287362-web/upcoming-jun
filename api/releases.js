// api/releases.js - Vercel Serverless Function
const { Pool } = require('@neondatabase/serverless');

// Database URL Neon Anda
const DATABASE_URL = 'postgresql://neondb_owner:npg_R5wU7GrHemYt@ep-muddy-sound-a14ehpek-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

let pool = null;

function getPool() {
    if (!pool) {
        pool = new Pool({ 
            connectionString: DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
    }
    return pool;
}

// API Configuration
const API_KEYS = {
    tmdb: 'a2c120d7d3aaaf1321ffe8a9899ef765',
    rawg: 'acb03a4a2dd04337b6b62eb78e325c59'
};

// Fetch functions
async function fetchTMDBMovies() {
    const url = `https://api.themoviedb.org/3/movie/upcoming?api_key=${API_KEYS.tmdb}&language=en-US&page=1`;
    const res = await fetch(url);
    const data = await res.json();
    return data.results?.slice(0, 15).map(movie => ({
        external_id: movie.id.toString(),
        category: 'movie',
        title: movie.title,
        release_date: movie.release_date,
        description: movie.overview?.substring(0, 500) || '',
        image_url: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
        rating: movie.vote_average,
        source_api: 'TMDB'
    })) || [];
}

async function fetchTMDSeries() {
    const url = `https://api.themoviedb.org/3/tv/on_the_air?api_key=${API_KEYS.tmdb}&language=en-US&page=1`;
    const res = await fetch(url);
    const data = await res.json();
    return data.results?.slice(0, 15).map(series => ({
        external_id: series.id.toString(),
        category: 'series',
        title: series.name,
        release_date: series.first_air_date,
        description: series.overview?.substring(0, 500) || '',
        image_url: series.poster_path ? `https://image.tmdb.org/t/p/w500${series.poster_path}` : null,
        rating: series.vote_average,
        source_api: 'TMDB'
    })) || [];
}

async function fetchRAWGGames() {
    const url = `https://api.rawg.io/api/games?key=${API_KEYS.rawg}&dates=2025-01-01,2027-12-31&ordering=released&page_size=15`;
    const res = await fetch(url);
    const data = await res.json();
    return data.results?.map(game => ({
        external_id: game.id.toString(),
        category: 'game',
        title: game.name,
        release_date: game.released,
        description: game.description_raw?.substring(0, 500) || '',
        image_url: game.background_image,
        rating: game.rating,
        source_api: 'RAWG'
    })) || [];
}

async function fetchAniListManga() {
    const query = `{
        Page(page: 1, perPage: 15) {
            media(type: MANGA, sort: POPULARITY_DESC, status: NOT_YET_RELEASED) {
                id, title { romaji }, startDate { year month day }, description, coverImage { large }, averageScore
            }
        }
    }`;
    const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    const { data } = await res.json();
    return data?.Page?.media.map(manga => {
        let release_date = null;
        if (manga.startDate.year) {
            release_date = `${manga.startDate.year}-${String(manga.startDate.month || 1).padStart(2, '0')}-${String(manga.startDate.day || 1).padStart(2, '0')}`;
        }
        return {
            external_id: manga.id.toString(),
            category: 'komik',
            title: manga.title.romaji || 'Upcoming Manga',
            release_date: release_date,
            description: manga.description?.replace(/<[^>]*>/g, '').substring(0, 500) || '',
            image_url: manga.coverImage?.large,
            rating: manga.averageScore ? manga.averageScore / 10 : null,
            source_api: 'AniList'
        };
    }) || [];
}

async function fetchOpenLibraryBooks() {
    const url = `https://openlibrary.org/search.json?q=fiction&sort=new&limit=15`;
    const res = await fetch(url);
    const data = await res.json();
    return data.docs?.map(book => ({
        external_id: book.key?.replace('/works/', '') || book.key,
        category: 'books',
        title: book.title,
        release_date: book.first_publish_year ? `${book.first_publish_year}-01-01` : null,
        description: book.author_name ? `By ${book.author_name.slice(0, 2).join(', ')}` : '',
        image_url: book.cover_i ? `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg` : null,
        rating: null,
        source_api: 'OpenLibrary'
    })) || [];
}

// Save to database
async function saveToDatabase(items) {
    if (!items.length) return 0;
    const pool = getPool();
    let saved = 0;
    
    for (const item of items) {
        const query = `
            INSERT INTO upcoming_releases 
            (external_id, category, title, release_date, description, image_url, rating, source_api)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (external_id, source_api) DO UPDATE SET
            title = EXCLUDED.title, release_date = EXCLUDED.release_date,
            description = EXCLUDED.description, image_url = EXCLUDED.image_url,
            rating = EXCLUDED.rating, updated_at = CURRENT_TIMESTAMP
        `;
        await pool.query(query, [
            item.external_id, item.category, item.title, item.release_date,
            item.description, item.image_url, item.rating, item.source_api
        ]);
        saved++;
    }
    return saved;
}

// Create tables if not exist
async function initTables() {
    const pool = getPool();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS upcoming_releases (
            id SERIAL PRIMARY KEY,
            external_id VARCHAR(255),
            category VARCHAR(50) NOT NULL,
            title VARCHAR(500) NOT NULL,
            release_date DATE,
            description TEXT,
            image_url TEXT,
            rating DECIMAL(3,1),
            source_api VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(external_id, source_api)
        )
    `);
}

// Main handler for Vercel
module.exports = async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
    
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    
    await initTables();
    const { method } = req;
    const { category } = req.query;
    
    // GET: Fetch releases from database
    if (method === 'GET') {
        try {
            const pool = getPool();
            let query = 'SELECT * FROM upcoming_releases';
            let params = [];
            
            if (category && category !== 'undefined') {
                query += ' WHERE category = $1';
                params.push(category);
            }
            
            query += ' ORDER BY release_date ASC NULLS LAST LIMIT 50';
            const result = await pool.query(query, params);
            
            res.status(200).json({
                success: true,
                count: result.rows.length,
                data: result.rows
            });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
    
    // POST: Sync all APIs to database
    else if (method === 'POST') {
        try {
            const results = [];
            
            const movies = await fetchTMDBMovies();
            const savedMovies = await saveToDatabase(movies);
            results.push({ category: 'movie', count: savedMovies });
            
            const series = await fetchTMDSeries();
            const savedSeries = await saveToDatabase(series);
            results.push({ category: 'series', count: savedSeries });
            
            const games = await fetchRAWGGames();
            const savedGames = await saveToDatabase(games);
            results.push({ category: 'game', count: savedGames });
            
            const komik = await fetchAniListManga();
            const savedKomik = await saveToDatabase(komik);
            results.push({ category: 'komik', count: savedKomik });
            
            const books = await fetchOpenLibraryBooks();
            const savedBooks = await saveToDatabase(books);
            results.push({ category: 'books', count: savedBooks });
            
            res.status(200).json({ success: true, results });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
    
    else {
        res.status(405).json({ error: 'Method not allowed' });
    }
};