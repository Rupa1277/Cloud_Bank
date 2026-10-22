# Load test for the autoscaling demo.
# Run:  docker run --rm -p 8089:8089 -v "${PWD}:/mnt/locust" -e API_KEY=<firebase web api key> -e EMAIL=<test user> -e PASSWORD=<pw> locustio/locust -f /mnt/locust/locustfile.py --host https://<your-project>.web.app
import os, requests
from locust import HttpUser, task, between

class Customer(HttpUser):
    wait_time = between(0.2, 1)

    def on_start(self):   # sign in once through Firebase's REST API to get a real JWT
        r = requests.post(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + os.environ["API_KEY"],
            json={"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"], "returnSecureToken": True}, timeout=15)
        self.headers = {"Authorization": "Bearer " + r.json()["idToken"]}

    @task(5)
    def balance(self):
        self.client.get("/api/account", headers=self.headers, name="/api/account")

    @task(3)
    def history(self):
        self.client.get("/api/transactions", headers=self.headers, name="/api/transactions")

    @task(1)
    def health(self):
        self.client.get("/api/health", name="/api/health")
