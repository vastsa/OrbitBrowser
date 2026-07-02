use crate::errors::AppResult;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Clone)]
pub struct Db {
    db_path: Arc<PathBuf>,
    data_dir: Arc<PathBuf>,
}

impl Db {
    pub fn initialize(data_dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(data_dir.join("profiles"))?;
        std::fs::create_dir_all(data_dir.join("runs"))?;
        std::fs::create_dir_all(data_dir.join("temp").join("proxy-extensions"))?;
        std::fs::create_dir_all(data_dir.join("backups").join("db"))?;

        let db_path = data_dir.join("app.sqlite");
        let db = Self {
            db_path: Arc::new(db_path),
            data_dir: Arc::new(data_dir),
        };
        let conn = db.connect()?;
        crate::storage::migrations::run(&conn, db.data_dir())?;
        Ok(db)
    }

    pub fn connect(&self) -> rusqlite::Result<Connection> {
        let conn = Connection::open(self.db_path.as_ref())?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    pub fn db_path(&self) -> &Path {
        self.db_path.as_ref()
    }

    pub fn data_dir(&self) -> &Path {
        self.data_dir.as_ref()
    }
}
