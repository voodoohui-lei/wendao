#!/usr/bin/env python3
"""
温道健康自检H5 - AI解读后端服务
运行方式: python health_api_server.py
服务启动后访问 http://localhost:8899
"""

import http.server
import urllib.request
import json
import urllib.parse

DEEPSEEK_KEY = "sk-95098d9dfed448798e1ed39f65780285"

# 温道系统的核心知识（注入给AI当背景知识）
SYSTEM_PROMPT = """你是温道全民健康系统的AI健康解读师。

【温道核心理念】
- 中医温养居家化，三分调七分养
- 三通体系：思通（理法认知）、温通（产品疗法）、疏通（技法疏通）
- 四大健康支柱：温度、气血、经络、思通（生活习惯）

【调理逻辑】
1. 温度（阳气不足）：靠内外热源补充
   - 外热源：元气正阳床垫（铺床上全身温敷，睡觉用）、元气多用毯（单独敷某个部位）
   - 内热源：姜汁、姜粉、姜片熬姜枣茶（内服补充热源）
2. 气血（精力/面色不足）：靠热能轻畅汤
   - 热能轻畅汤（排毒汤）：排肠道垃圾、清宿便，同时补肾气
3. 经络（经络不通）：三种解决路径
   - 居家自我疏通：用孝顺锤配合姜膏（外用的）拍打经络
   - 学习：参加家庭调理师3天课程，学习居家疏通术，让家人帮忙疏通
   - 门店：到温道门店找专业技师疏通
   （⚠️ 绝对不要推荐温大敷课程或温敷姜疗课程给普通用户，那是给专业技师学的）
4. 思通（不良生活习惯）：靠课程学习
   - 家庭调理师3天课程（基础）
   - 思通理论课（高阶）

【产品正确介绍】
- 元气正阳床垫：铺在床上全身深度温敷，晚上睡觉用，不能单独敷某个部位
- 元气多用毯：可单独敷某个部位（肩颈、腰、膝等）
- 热能轻畅汤（排毒汤）：排肠道垃圾、清宿便，同时补肾气
- 姜膏：**外用**，涂在经络部位配合拍打/按推使用，不能内服
- 姜汁/姜粉/姜片：**内服**，熬姜枣茶喝，补充内热源
- 孝顺锤：居家经络疏通工具，配合姜膏（外用）使用

【回复要求】
- 每次输出约200-300字，通俗易懂，有温度
- 先说问题本质，再说解决方案
- 自然带入温道产品和课程，不要生硬推销
- 最后给一个可执行的"下一步行动"建议
- 语气：专业但不学术，温暖但不煽情
- 参考格式：先点评整体健康状态 → 分析每个维度问题 → 给出产品和学习建议 → 1句话结尾

【绝对禁止】
- 🔴 经络问题绝对不要推荐"温大敷课程"或"温敷姜疗课程"给普通用户，这些是专业技师课程
- 🔴 经络问题的推荐只能是：孝顺锤+姜膏（外用）自我疏通 / 学家庭调理师课程让家人帮忙 / 到门店找专业技师
- 🔴 不要混淆姜膏（外用）和姜汁/姜粉/姜片（内服）
- 🔴 元气正阳床垫只能全身温敷，不能敷局部，局部用元气多用毯"""

def call_deepseek(user_content):
    """调用DeepSeek API"""
    data = json.dumps({
        "model": "deepseek-chat",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content}
        ],
        "max_tokens": 800,
        "temperature": 0.7,
        "stream": False
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.deepseek.com/v1/chat/completions",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DEEPSEEK_KEY}"
        }
    )
    resp = urllib.request.urlopen(req, timeout=30)
    result = json.loads(resp.read().decode("utf-8"))
    return result["choices"][0]["message"]["content"]


class HealthHandler(http.server.BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            html = """<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:40px">
<h2>温道健康自检H5 - AI解读服务</h2>
<p>服务运行正常 &#9989;</p>
<p>H5页面: <a href="/h5">打开健康自检</a></p>
<p>API地址: POST /analyze</p>
</body></html>"""
            self.wfile.write(html.encode("utf-8"))
        elif self.path == "/h5":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            # 读取H5 HTML内容
            try:
                with open("温道健康自检H5.html", "r", encoding="utf-8") as f:
                    content = f.read()
                self.wfile.write(content.encode("utf-8"))
            except:
                self.wfile.write("<h1>H5文件未找到</h1>".encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/analyze":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode("utf-8"))

            scores = data.get("scores", {})
            selected_items = data.get("selected", {})

            # 构建AI输入
            def fmt_dim(key, name, emoji, items):
                cnt = scores.get(key, 0)
                if cnt == 0:
                    return ""
                sel_items = selected_items.get(key, [])
                items_str = "、".join(sel_items[:8])
                if len(sel_items) > 8:
                    items_str += f"等{cnt}项"
                return f"{emoji} {name}（{cnt}项）：{items_str}"

            user_input = "请根据以下用户自检结果，生成一份个性化的健康解读和调理建议。\n\n"
            parts = [
                fmt_dim("temp", "温度", "🌡️", selected_items.get("temp", [])),
                fmt_dim("blood", "气血", "🔴", selected_items.get("blood", [])),
                fmt_dim("meridian", "经络", "🔗", selected_items.get("meridian", [])),
                fmt_dim("life", "思通(生活习惯)", "🧠", selected_items.get("life", []))
            ]
            user_input += "\n".join(p for p in parts if p)
            user_input += "\n\n请结合温道的调理逻辑给出解读和建议（温度→内外热源、气血→热能轻畅汤、经络→外治法/课程、思通→家调课程）。"

            try:
                reply = call_deepseek(user_input)
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "text": reply}, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        print(f"[温道API] {args[0]} {args[1]} {args[2]}")


if __name__ == "__main__":
    port = 8899
    server = http.server.HTTPServer(("127.0.0.1", port), HealthHandler)
    print(f"[OK] 温道健康自检AI服务已启动")
    print(f"   本地服务器: http://127.0.0.1:{port}")
    print(f"   H5页面: http://127.0.0.1:{port}/h5")
    print(f"   API接口: POST http://127.0.0.1:{port}/analyze")
    print(f"   按 Ctrl+C 停止服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
