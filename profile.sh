#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

VITE_PID=""

cleanup() {
  if [ -n "${VITE_PID}" ]; then
    kill "${VITE_PID}" 2>/dev/null || true
    wait "${VITE_PID}" 2>/dev/null || true
  fi
  if [ -n "${DARKSLIDE_DB_PATH:-}" ]; then
    rm -f "${DARKSLIDE_DB_PATH}" "${DARKSLIDE_DB_PATH}-wal" "${DARKSLIDE_DB_PATH}-shm" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if ! curl -s http://localhost:1420 > /dev/null 2>&1; then
  VITE_PROFILING=true bun run ui:dev > /dev/null 2>&1 &
  VITE_PID=$!
  while ! curl -s http://localhost:1420 > /dev/null 2>&1; do
    if ! kill -0 "${VITE_PID}" 2>/dev/null; then
      exit 1
    fi
    sleep 0.2
  done
fi

TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
RUN_DIR="${PROJECT_DIR}/profiles/run_${TIMESTAMP}"
mkdir -p "${RUN_DIR}"

export VITE_PROFILING=true
export DARKSLIDE_PROFILE_DIR="${RUN_DIR}"
export DARKSLIDE_TIMESTAMP="${TIMESTAMP}"
export DARKSLIDE_DB_PATH="${RUN_DIR}/darkslide_profile_${TIMESTAMP}.sqlite"

RUSTFLAGS="-C target-cpu=native" cargo build --profile profiling -p darkslide --features profiling

TRACE_FILE="${RUN_DIR}/darkslide_${TIMESTAMP}.trace"

OPEN_TRACE="${OPEN_TRACE:-false}"
IMAGE_PATH=""
HAS_SCENARIO=false
EXTRA_ARGS=()

if [ $# -eq 0 ]; then
  HAS_SCENARIO=true
  IMAGE_PATH="${PROJECT_DIR}/test_fixtures/images"
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scenario)
        HAS_SCENARIO=true
        shift
        ;;
      --open)
        OPEN_TRACE=true
        shift
        ;;
      --images|--source|-i)
        IMAGE_PATH="$2"
        shift 2
        ;;
      --images=*|--source=*)
        IMAGE_PATH="${1#*=}"
        shift
        ;;
      *)
        if [ -z "$IMAGE_PATH" ] && [ -e "$1" ]; then
          IMAGE_PATH="$1"
        else
          EXTRA_ARGS+=("$1")
        fi
        shift
        ;;
    esac
  done
fi

if [ -z "$IMAGE_PATH" ]; then
  IMAGE_PATH="${DARKSLIDE_IMAGES_DIR:-${DARKSLIDE_IMAGES_PATH:-${PROFILE_IMAGES_DIR:-${PROJECT_DIR}/test_fixtures/images}}}"
fi

APP_ARGS=("$IMAGE_PATH")
if [ "$HAS_SCENARIO" = "true" ]; then
  APP_ARGS+=("--scenario")
fi
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
  APP_ARGS+=("${EXTRA_ARGS[@]}")
fi

echo ""
echo "=== Starting Profiling Run ==="
echo " Image source: ${IMAGE_PATH}"
echo " Scenario mode: ${HAS_SCENARIO}"
echo " Run directory: ${RUN_DIR}"
echo "==============================="
echo ""

MEM_LOG="${RUN_DIR}/memory_timeline.csv"
echo "elapsed_sec,darkslide_rss_mb,webkit_rss_mb,total_rss_mb" > "${MEM_LOG}"

# Snapshot any pre-existing WebKit processes so we distinguish Darkslide's web process
PRE_WEB_PIDS=$(pgrep -f "com.apple.WebKit.WebContent" 2>/dev/null || true)

MONITOR_PID=""
(
  START_TIME=$(date +%s)
  PEAK_W_KB=0
  CAPTURED_PEAK=false
  while true; do
    D_PID=$(pgrep -x darkslide 2>/dev/null | head -1 || true)
    if [ -n "${D_PID}" ]; then
      NOW=$(date +%s)
      ELAPSED=$((NOW - START_TIME))

      D_RSS_KB=$(ps -o rss= -p "${D_PID}" 2>/dev/null || echo "0")
      D_RSS_MB=$(awk "BEGIN {printf \"%.2f\", ${D_RSS_KB:-0} / 1024}")

      W_RSS_KB=0
      FIRST_WEB_PID=""
      ALL_WEB_PIDS=$(pgrep -u $(id -u) -f "com.apple.WebKit.WebContent" 2>/dev/null || true)
      for pid in $ALL_WEB_PIDS; do
        if ! echo "$PRE_WEB_PIDS" | grep -qw "$pid" 2>/dev/null; then
          KB=$(ps -o rss= -p "$pid" 2>/dev/null || echo "0")
          W_RSS_KB=$((W_RSS_KB + KB))
          if [ -z "$FIRST_WEB_PID" ]; then FIRST_WEB_PID="$pid"; fi
        fi
      done
      # If no diff, count all
      if [ "$W_RSS_KB" -eq 0 ] && [ -n "$ALL_WEB_PIDS" ]; then
        for pid in $ALL_WEB_PIDS; do
          KB=$(ps -o rss= -p "$pid" 2>/dev/null || echo "0")
          W_RSS_KB=$((W_RSS_KB + KB))
          if [ -z "$FIRST_WEB_PID" ]; then FIRST_WEB_PID="$pid"; fi
        done
      fi
      W_RSS_MB=$(awk "BEGIN {printf \"%.2f\", ${W_RSS_KB} / 1024}")
      TOTAL_MB=$(awk "BEGIN {printf \"%.2f\", ${D_RSS_MB} + ${W_RSS_MB}}")
      echo "${ELAPSED},${D_RSS_MB},${W_RSS_MB},${TOTAL_MB}" >> "${MEM_LOG}"

      if [ "$W_RSS_KB" -gt "$PEAK_W_KB" ]; then
        PEAK_W_KB=$W_RSS_KB
        if [ -n "$FIRST_WEB_PID" ] && [ "$W_RSS_KB" -gt 150000 ]; then
          (vmmap -summary "$FIRST_WEB_PID" > "${RUN_DIR}/webkit_vmmap_peak.txt" 2>&1) &
        fi
      fi
    fi
    sleep 0.5
  done
) 2>/dev/null &
MONITOR_PID=$!

xcrun xctrace record \
  --template 'Game Performance Overview' \
  --instrument 'Activity Monitor' \
  --instrument 'Allocations' \
  --output "${TRACE_FILE}" \
  --launch -- ./target/profiling/darkslide "${APP_ARGS[@]}"

if [ -n "${MONITOR_PID:-}" ]; then
  kill "${MONITOR_PID}" 2>/dev/null || true
  wait "${MONITOR_PID}" 2>/dev/null || true
fi

WEB_TRACE="${RUN_DIR}/darkslide_web_${TIMESTAMP}.json"
echo ""
echo "======================================================="
echo " Profiling Session Complete"
echo " Run directory: ${RUN_DIR}"
echo " - Native Instruments Trace: ${TRACE_FILE}"
if [ -f "${WEB_TRACE}" ]; then
  echo " - Web Performance Trace:   ${WEB_TRACE}"
fi
if [ -f "${MEM_LOG}" ] && [ $(wc -l < "${MEM_LOG}") -gt 1 ]; then
  echo " - Memory Timeline:         ${MEM_LOG}"
  PEAK_D=$(awk -F',' 'NR>1 {if($2>max) max=$2} END {print max}' "${MEM_LOG}")
  PEAK_W=$(awk -F',' 'NR>1 {if($3>max) max=$3} END {print max}' "${MEM_LOG}")
  PEAK_T=$(awk -F',' 'NR>1 {if($4>max) max=$4} END {print max}' "${MEM_LOG}")
  echo "   * Peak Rust (darkslide): ${PEAK_D:-0} MB"
  echo "   * Peak Web (WebKit):     ${PEAK_W:-0} MB"
  echo "   * Peak Total:            ${PEAK_T:-0} MB"
fi
if [ -f "${RUN_DIR}/webkit_vmmap_peak.txt" ]; then
  echo ""
  echo "--- WebKit Memory Breakdown (Peak) ---"
  grep -A 20 "REGION TYPE" "${RUN_DIR}/webkit_vmmap_peak.txt" 2>/dev/null || true
  echo "--------------------------------------"
fi
echo "======================================================="

if [ "${OPEN_TRACE}" = "true" ] && [ -e "${TRACE_FILE}" ]; then
  open "${TRACE_FILE}"
fi

