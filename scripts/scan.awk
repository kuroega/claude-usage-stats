# Reduces Claude Code transcripts (.jsonl) to per-hour totals.
#
# For each file it prints "F<TAB>path", then one row per UTC hour:
#   H<TAB>YYYY-MM-DDTHH<TAB>input<TAB>output<TAB>cacheWrite<TAB>cacheRead<TAB>replies<TAB>prompts
# and one row per hour and model:
#   M<TAB>YYYY-MM-DDTHH<TAB>model<TAB>tokens
#
# A reply is one API message: its blocks are written as several rows sharing
# a message id, so the last row of each id wins. A prompt is a user row that
# is neither a tool result nor meta. Quotes inside message text are escaped in
# JSON, so an unescaped key match is always a real key.

function num(s, key,    i, rest) {
  i = index(s, "\"" key "\":")
  if (i == 0) return 0
  rest = substr(s, i + length(key) + 3)
  if (!match(rest, /^[0-9]+/)) return 0
  return substr(rest, 1, RLENGTH) + 0
}

# The row's own timestamp is the last one on the line, after the message.
function hourOf(line,    i, rest, ts) {
  ts = ""; rest = line
  while ((i = index(rest, "\"timestamp\":\"")) > 0) {
    rest = substr(rest, i + 13)
    ts = substr(rest, 1, 13)
  }
  return length(ts) == 13 ? ts : ""
}

function flush(    id, h, m, k, all) {
  if (file == "") return
  print "F\t" file
  for (id in replyHour) {
    h = replyHour[id]
    m = replyModel[id]
    all = inOf[id] + outOf[id] + cwOf[id] + crOf[id]
    tin[h] += inOf[id]; tout[h] += outOf[id]
    tcw[h] += cwOf[id]; tcr[h] += crOf[id]; tn[h]++
    hours[h] = 1
    if (m != "" && m != "<synthetic>") tm[h "\t" m] += all
  }
  for (h in tp) hours[h] = 1
  for (h in hours) {
    print "H\t" h "\t" (tin[h] + 0) "\t" (tout[h] + 0) "\t" (tcw[h] + 0) "\t" (tcr[h] + 0) "\t" (tn[h] + 0) "\t" (tp[h] + 0)
  }
  for (k in tm) print "M\t" k "\t" tm[k]
  split("", replyHour); split("", replyModel); split("", inOf); split("", outOf)
  split("", cwOf); split("", crOf)
  split("", tin); split("", tout); split("", tcw); split("", tcr); split("", tn)
  split("", tp); split("", tm); split("", hours)
}

FNR == 1 { flush(); file = FILENAME }

index($0, "\"type\":\"user\"") > 0 {
  if (index($0, "\"tool_result\"") > 0 || index($0, "\"isMeta\":true") > 0) next
  h = hourOf($0)
  if (h != "") tp[h]++
  next
}

{
  u = index($0, "\"usage\":{")
  if (u == 0 || index($0, "\"role\":\"assistant\"") == 0) next
  if (!match($0, /"id":"msg_[A-Za-z0-9_-]+"/)) next
  id = substr($0, RSTART + 6, RLENGTH - 7)
  h = hourOf($0)
  if (h == "") next

  model = ""
  if (match($0, /"model":"[^"]+"/)) model = substr($0, RSTART + 9, RLENGTH - 10)

  usage = substr($0, u)
  replyHour[id] = h
  replyModel[id] = model
  inOf[id] = num(usage, "input_tokens")
  outOf[id] = num(usage, "output_tokens")
  cwOf[id] = num(usage, "cache_creation_input_tokens")
  crOf[id] = num(usage, "cache_read_input_tokens")
}

END { flush() }
