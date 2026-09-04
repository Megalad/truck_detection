import requests

TELEGRAM_BOT_TOKEN = "8633570454:AAEK0wMLoWApzcnzuQAxvubtyyGBfl-FuPQ"
TELEGRAM_CHAT_ID = "-5394933515"

def test():
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    data = {'chat_id': TELEGRAM_CHAT_ID, 'text': "Test message from server"}
    try:
        response = requests.post(url, data=data)
        print(response.status_code, response.text)
    except Exception as e:
        print(f"Exception: {e}")

test()
