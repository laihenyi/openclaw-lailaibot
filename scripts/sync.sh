#!/bin/bash
#
# OpenClaw 同步腳本
# 保持 ~/.openclaw 和 repo 之間的代碼一致
#
# 用法:
#   ./sync.sh pull   - 從 repo 同步到 ~/.openclaw (部署)
#   ./sync.sh push   - 從 ~/.openclaw 同步到 repo (備份)
#   ./sync.sh status - 顯示差異狀態
#

set -e

REPO_DIR="$HOME/openclaw-lailaibot"
OPENCLAW_DIR="$HOME/.openclaw"

# 顏色輸出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 同步映射: repo路徑 -> openclaw路徑
declare -A SYNC_MAP=(
    ["agents/ai-trends"]="agents/ai-trends"
    ["agents/video-subtitle"]="agents/video-subtitle"
    ["local-skills/discord-voice-bot"]="skills/discord-voice-bot"
)

# 要排除的文件/目錄 (雙向)
EXCLUDES=(
    "node_modules"
    "venv"
    "*.log"
    "*.mp3"
    "*.wav"
    "recordings"
    "tts_output"
    "memory"
    "__pycache__"
    "*.pyc"
    ".env"
)

# Push 時保留的 repo 專屬文件 (不刪除)
REPO_ONLY_FILES=(
    ".gitignore"
    "README.md"
)

build_rsync_excludes() {
    local excludes=""
    for e in "${EXCLUDES[@]}"; do
        excludes="$excludes --exclude=$e"
    done
    echo "$excludes"
}

sync_pull() {
    log_info "從 repo 同步到 ~/.openclaw (部署模式)"

    # 先 git pull
    cd "$REPO_DIR"
    log_info "Git pull..."
    git pull origin main

    local excludes=$(build_rsync_excludes)

    for repo_path in "${!SYNC_MAP[@]}"; do
        local openclaw_path="${SYNC_MAP[$repo_path]}"
        local src="$REPO_DIR/$repo_path/"
        local dst="$OPENCLAW_DIR/$openclaw_path/"

        if [ -d "$src" ]; then
            log_info "同步: $repo_path -> $openclaw_path"
            mkdir -p "$dst"
            rsync -av --delete $excludes "$src" "$dst"
            log_success "完成: $openclaw_path"
        else
            log_warn "來源不存在: $src"
        fi
    done

    log_success "同步完成！可能需要重啟 Bot 服務。"
}

sync_push() {
    log_info "從 ~/.openclaw 同步到 repo (備份模式)"

    local excludes=$(build_rsync_excludes)

    # 為 push 添加 repo 專屬文件的排除
    local push_excludes="$excludes"
    for f in "${REPO_ONLY_FILES[@]}"; do
        push_excludes="$push_excludes --exclude=$f"
    done

    for repo_path in "${!SYNC_MAP[@]}"; do
        local openclaw_path="${SYNC_MAP[$repo_path]}"
        local src="$OPENCLAW_DIR/$openclaw_path/"
        local dst="$REPO_DIR/$repo_path/"

        if [ -d "$src" ]; then
            log_info "同步: $openclaw_path -> $repo_path"
            mkdir -p "$dst"
            # 不使用 --delete，保留 repo 專屬文件
            rsync -av $push_excludes "$src" "$dst"
            log_success "完成: $repo_path"
        else
            log_warn "來源不存在: $src"
        fi
    done

    # 顯示 git 狀態
    cd "$REPO_DIR"
    echo ""
    log_info "Git 狀態:"
    git status --short

    echo ""
    log_info "如需提交，請執行:"
    echo "  cd $REPO_DIR && git add -A && git commit -m 'sync: update from local' && git push"
}

sync_status() {
    log_info "檢查同步狀態..."
    echo ""

    for repo_path in "${!SYNC_MAP[@]}"; do
        local openclaw_path="${SYNC_MAP[$repo_path]}"
        local repo_full="$REPO_DIR/$repo_path"
        local openclaw_full="$OPENCLAW_DIR/$openclaw_path"

        echo -e "${BLUE}[$repo_path]${NC}"

        if [ ! -d "$repo_full" ]; then
            log_warn "  Repo: 不存在"
        elif [ ! -d "$openclaw_full" ]; then
            log_warn "  OpenClaw: 不存在"
        else
            # 比較主要文件
            local diff_count=$(diff -rq "$repo_full" "$openclaw_full" \
                --exclude=node_modules \
                --exclude=venv \
                --exclude=*.log \
                --exclude=recordings \
                --exclude=tts_output \
                --exclude=memory \
                --exclude=__pycache__ \
                2>/dev/null | wc -l)

            if [ "$diff_count" -eq 0 ]; then
                log_success "  ✓ 同步"
            else
                log_warn "  ✗ 有 $diff_count 個差異"
                diff -rq "$repo_full" "$openclaw_full" \
                    --exclude=node_modules \
                    --exclude=venv \
                    --exclude=*.log \
                    --exclude=recordings \
                    --exclude=tts_output \
                    --exclude=memory \
                    --exclude=__pycache__ \
                    2>/dev/null | head -5 | sed 's/^/    /'
            fi
        fi
        echo ""
    done
}

commit_and_push() {
    log_info "提交並推送變更..."

    cd "$REPO_DIR"

    if [ -z "$(git status --porcelain)" ]; then
        log_info "沒有變更需要提交"
        return
    fi

    git add -A

    local msg="${1:-sync: update from local}"
    git commit -m "$msg

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

    git push origin main
    log_success "推送完成！"
}

show_help() {
    echo "OpenClaw 同步腳本"
    echo ""
    echo "用法: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  pull      從 repo 同步到 ~/.openclaw (部署)"
    echo "  push      從 ~/.openclaw 同步到 repo (備份)"
    echo "  status    顯示差異狀態"
    echo "  commit    提交並推送 (需提供 commit message)"
    echo "  help      顯示此幫助"
    echo ""
    echo "範例:"
    echo "  $0 pull                    # 部署最新代碼"
    echo "  $0 push                    # 備份本地修改"
    echo "  $0 commit 'fix: bug fix'   # 提交並推送"
}

# 主程序
case "${1:-help}" in
    pull)
        sync_pull
        ;;
    push)
        sync_push
        ;;
    status)
        sync_status
        ;;
    commit)
        sync_push
        commit_and_push "$2"
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "未知命令: $1"
        show_help
        exit 1
        ;;
esac
