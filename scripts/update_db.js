import mysql from "mysql2/promise";

const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD || '12345678', // matching live_server.py default
  database: 'section35_db'
};

async function updateDB() {
  console.log("Attempting to connect to MySQL...");
  try {
    const connection = await mysql.createConnection(dbConfig);
    console.log("✅ Connected successfully!");
    
    console.log("Adding evidence_snapshot_url column...");
    try {
      await connection.execute('ALTER TABLE violations ADD COLUMN evidence_snapshot_url VARCHAR(255)');
      console.log(`✅ Column added!`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log("⚠️ Column already exists. Skipping.");
      } else {
        throw err;
      }
    }
    
    await connection.end();
  } catch (err) {
    console.error("❌ Connection or query failed:", err.message);
  }
}

updateDB();
