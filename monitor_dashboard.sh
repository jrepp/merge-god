#!/bin/bash
# Monitor dashboard in tmux session with periodic screen captures

SESSION_NAME="merge-god-monitor"
CAPTURE_DIR="./dashboard_captures"
CAPTURE_INTERVAL=3
MAX_CAPTURES=20

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Dashboard Monitor Script${NC}"
echo "Session: $SESSION_NAME"
echo "Capture interval: ${CAPTURE_INTERVAL}s"
echo "Max captures: $MAX_CAPTURES"
echo ""

# Clean old captures
if [ -d "$CAPTURE_DIR" ]; then
    echo -e "${YELLOW}Cleaning old captures...${NC}"
    rm -rf "$CAPTURE_DIR"
fi

# Create capture directory
mkdir -p "$CAPTURE_DIR"
echo -e "${GREEN}Capture directory ready${NC}"
echo ""

# Check if tmux session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo -e "${YELLOW}Session $SESSION_NAME already exists. Killing it...${NC}"
    tmux kill-session -t "$SESSION_NAME"
    sleep 1
fi

# Create new tmux session
echo -e "${GREEN}Creating tmux session...${NC}"
tmux new-session -d -s "$SESSION_NAME" -x 120 -y 40

# Launch dashboard in the session
echo -e "${GREEN}Launching dashboard...${NC}"
tmux send-keys -t "$SESSION_NAME" "./dashboard.py config.yaml" C-m

# Wait for initial startup
sleep 2

# Capture screens periodically
echo -e "${GREEN}Starting capture loop...${NC}"
echo ""

for i in $(seq 1 $MAX_CAPTURES); do
    TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
    CAPTURE_FILE="$CAPTURE_DIR/capture_${i}_${TIMESTAMP}.txt"

    # Capture the screen
    tmux capture-pane -t "$SESSION_NAME" -p > "$CAPTURE_FILE"

    # Display capture number and timestamp
    echo -e "${GREEN}[Capture $i/$MAX_CAPTURES]${NC} $TIMESTAMP"

    # Check for errors in the capture
    if grep -q "Error\|error\|ERROR\|Failed\|failed\|FAILED\|Exception" "$CAPTURE_FILE"; then
        echo -e "${RED}  ⚠ Potential errors detected in capture${NC}"
    fi

    # Check if dashboard is running
    if grep -q "merge-god Dashboard" "$CAPTURE_FILE"; then
        echo -e "${GREEN}  ✓ Dashboard TUI is running${NC}"
    elif grep -q "Starting dashboard" "$CAPTURE_FILE"; then
        echo -e "${YELLOW}  ⏳ Dashboard is starting...${NC}"
    elif grep -q "Shutting down" "$CAPTURE_FILE"; then
        echo -e "${RED}  ✗ Dashboard is shutting down${NC}"
        break
    fi

    # Show last few lines of capture
    echo -e "${YELLOW}  Last lines:${NC}"
    tail -3 "$CAPTURE_FILE" | sed 's/^/    /'
    echo ""

    # Wait before next capture
    if [ $i -lt $MAX_CAPTURES ]; then
        sleep $CAPTURE_INTERVAL
    fi
done

echo ""
echo -e "${GREEN}Capture complete. Files saved to: $CAPTURE_DIR${NC}"
echo ""

# Show final capture
LATEST_CAPTURE=$(ls -t "$CAPTURE_DIR"/capture_*.txt | head -1)
if [ -f "$LATEST_CAPTURE" ]; then
    echo -e "${GREEN}=== Final Screen State ===${NC}"
    cat "$LATEST_CAPTURE"
    echo ""
fi

# Check if session is still running
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo -e "${GREEN}Session $SESSION_NAME is still running.${NC}"
    echo "To view: tmux attach -t $SESSION_NAME"
    echo "To kill: tmux kill-session -t $SESSION_NAME"
else
    echo -e "${YELLOW}Session $SESSION_NAME has terminated.${NC}"
fi

# Analyze captures for issues
echo ""
echo -e "${GREEN}=== Analysis ===${NC}"

# Count errors
ERROR_COUNT=$(grep -l "Error\|error\|ERROR\|Failed\|failed\|FAILED\|Exception" "$CAPTURE_DIR"/capture_*.txt | wc -l | tr -d ' ')
if [ "$ERROR_COUNT" -gt 0 ]; then
    echo -e "${RED}Found errors in $ERROR_COUNT captures${NC}"
    echo "Files with errors:"
    grep -l "Error\|error\|ERROR\|Failed\|failed\|FAILED\|Exception" "$CAPTURE_DIR"/capture_*.txt | sed 's/^/  /'
else
    echo -e "${GREEN}No errors detected${NC}"
fi

# Check if TUI ever started
TUI_COUNT=$(grep -l "merge-god Dashboard" "$CAPTURE_DIR"/capture_*.txt | wc -l | tr -d ' ')
if [ "$TUI_COUNT" -gt 0 ]; then
    echo -e "${GREEN}TUI started successfully in $TUI_COUNT captures${NC}"
else
    echo -e "${YELLOW}TUI never started (might still be initializing)${NC}"
fi

echo ""
echo -e "${GREEN}Done!${NC}"
