ALTER TABLE complaints ADD COLUMN follow_ups TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX notification_provider_message_idx ON notifications(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE notification_callbacks (id TEXT PRIMARY KEY, provider_message_id TEXT NOT NULL, status TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE test_notification_rate_limits (recipient_user_id TEXT PRIMARY KEY REFERENCES users(id), last_sent_at TEXT NOT NULL);

INSERT OR IGNORE INTO organizations VALUES ('org-1','Fictional Seven Store Group',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO users VALUES
('father','org-1','Father','father@example.invalid','', 'OWNER',1,0,'America/New_York',datetime('now'),datetime('now')),
('uncle','org-1','Uncle','uncle@example.invalid','', 'OWNER',1,0,'America/New_York',datetime('now'),datetime('now')),
('grandfather','org-1','Grandfather','grandfather@example.invalid','', 'VIEW_ONLY',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-1','org-1','Manager Store 1','manager1@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-2','org-1','Manager Store 2','manager2@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-3','org-1','Manager Store 3','manager3@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-4','org-1','Manager Store 4','manager4@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-5','org-1','Manager Store 5','manager5@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-6','org-1','Manager Store 6','manager6@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now')),
('manager-7','org-1','Manager Store 7','manager7@example.invalid','', 'STORE_MANAGER',1,0,'America/New_York',datetime('now'),datetime('now'));
INSERT OR IGNORE INTO stores VALUES
('store-1','org-1','41001','Riverside Dunkin','100 River Rd','Brewster','MA','01720','+15550300001',1,'manager-1',NULL,datetime('now'),datetime('now')),
('store-2','org-1','41002','Oak Street Dunkin','120 Oak St','Brewster','MA','01721','+15550300002',1,'manager-2',NULL,datetime('now'),datetime('now')),
('store-3','org-1','41003','Northgate Dunkin','140 North Ave','Brewster','MA','01722','+15550300003',1,'manager-3',NULL,datetime('now'),datetime('now')),
('store-4','org-1','41004','Market Square Dunkin','160 Market St','Brewster','MA','01723','+15550300004',1,'manager-4',NULL,datetime('now'),datetime('now')),
('store-5','org-1','41005','Hillcrest Dunkin','180 Hill Rd','Brewster','MA','01724','+15550300005',1,'manager-5',NULL,datetime('now'),datetime('now')),
('store-6','org-1','41006','Lakeside Dunkin','200 Lake Dr','Brewster','MA','01725','+15550300006',1,'manager-6',NULL,datetime('now'),datetime('now')),
('store-7','org-1','41007','Park Avenue Dunkin','220 Park Ave','Brewster','MA','01726','+15550300007',1,'manager-7',NULL,datetime('now'),datetime('now'));
INSERT INTO settings(key,value,updated_at) VALUES('notification_mode','FAMILY_PILOT',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='FAMILY_PILOT',updated_at=datetime('now');
INSERT INTO settings(key,value,updated_at) VALUES('external_notifications_enabled','false',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='false',updated_at=datetime('now');
