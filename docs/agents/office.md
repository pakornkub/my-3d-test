# Office

สิ่งที่ทีม agent ต้องรู้เกี่ยวกับ repo นี้ แก้ไฟล์นี้ได้เลย server อ่านใหม่ทุกครั้งที่เริ่มงาน

## Commands
dev: npm run dev -- --port {port}    # ใช้ {port} แทนพอร์ต
test: npm test
typecheck: 
e2e: 
db:     # รันในทุก worktree ใหม่

## Worktree
port-base: 3100
db-per-worktree: none    # none | sqlite-file | postgres-docker | shared
env-template: 

## Policy
verify: exploratory    # none | scripted | exploratory
bash-allowlist: cd, npm, npx, node, git status, git diff, git log, git add, git commit, git stash, ls, cat, head, tail, grep, wc, echo, find, dir    # คั่นด้วย , จับคู่ตามคำขึ้นต้น
daily-budget-usd: 10
stall-minutes: 6
max-turns: 60
ticket-budget-usd: 6
attempts: 2
