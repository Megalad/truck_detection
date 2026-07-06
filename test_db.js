import mysql from "mysql2/promise";

const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '', // NOTE: Ensure this matches the updated password in live_server.py and server.js
  database: 'section35_db'
};

async function testConnection() {
  console.log("Attempting to connect to MySQL...");
  try {
    const connection = await mysql.createConnection(dbConfig);
    console.log("✅ Connected successfully!");
    
    console.log("Executing SELECT query...");
    const [rows] = await connection.execute('SELECT * FROM violations');
    
    console.log(`✅ Query successful! Found ${rows.length} violations.`);
    console.log("Data:");
    console.log(JSON.stringify(rows, null, 2));
    
    await connection.end();
  } catch (err) {
    console.error("❌ Connection or query failed:", err.message);
  }
}

testConnection();
