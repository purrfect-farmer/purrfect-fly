const { default: axios, isAxiosError } = require("axios");
const hpAgent = require("hpagent");
const { CookieJar } = require("tough-cookie");
const seedrandom = require("seedrandom");

const db = require("../db/models");
const GramClient = require("../lib/GramClient");
const userAgents = require("../lib/userAgents");
const utils = require("../lib/utils");
const bot = require("../lib/bot");
const {
  createCookieAgent,
  HttpCookieAgent,
  HttpsCookieAgent,
} = require("http-cookie-agent/http");
const { default: chalk } = require("chalk");
const { HttpProxyAgent } = require("hpagent");
const { HttpsProxyAgent } = require("hpagent");

const HttpProxyAgentWithCookies = createCookieAgent(HttpProxyAgent);
const HttpsProxyAgentWithCookies = createCookieAgent(HttpsProxyAgent);

class BaseFarmer {
  static _isRunning = false;

  constructor(config, farmer) {
    this.config = config;
    this.farmer = farmer;
    this.utils = require("../lib/utils");

    this.cookies = this.constructor.cookies;
    this.random = seedrandom(this.farmer.account.id);
    this.userAgent = userAgents[Math.floor(this.random() * userAgents.length)];
    this.jar = this.cookies ? new CookieJar() : null;

    /** Proxy URL */
    this.proxy = this.farmer.account.proxy
      ? `http://${this.farmer.account.proxy}`
      : null;

    this.httpAgent = this.proxy
      ? this.cookies
        ? new HttpProxyAgentWithCookies({
            proxy: this.proxy,
            cookies: { jar: this.jar },
          })
        : new HttpProxyAgent({ proxy: this.proxy })
      : this.cookies
      ? new HttpCookieAgent({ cookies: { jar: this.jar } })
      : null;

    /** HttpsAgent */
    this.httpsAgent = this.proxy
      ? this.cookies
        ? new HttpsProxyAgentWithCookies({
            proxy: this.proxy,
            cookies: { jar: this.jar },
          })
        : new HttpsProxyAgent({ proxy: this.proxy })
      : this.cookies
      ? new HttpsCookieAgent({ cookies: { jar: this.jar } })
      : null;

    /** Create API */
    this.api = axios.create({
      timeout: 60_000,
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      headers: {
        common: {
          ["User-Agent"]: this.userAgent,
          ["Origin"]: this.constructor.origin,
          ["Referer"]: this.constructor.origin + "/",
          ["Referrer-Policy"]: "strict-origin-when-cross-origin",
          ["Cache-Control"]: "no-cache",
          ["X-Requested-With"]: "org.telegram.messenger",
        },
      },
    });

    /** Apply Delay */
    this.api.interceptors.request.use((config) =>
      this.constructor.delay
        ? new Promise((resolve) =>
            setTimeout(resolve, this.constructor.delay * 1000, config)
          )
        : config
    );

    /** Set Headers */
    this.api.interceptors.request.use((config) => {
      /** Apply Headers */
      config.headers = {
        ...config.headers,
        ...this.farmer.headers,
        ...this.getExtraHeaders?.(),
      };
      return config;
    });

    /** Refetch Auth */
    this.api.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        if (
          [401, 403, 418].includes(error?.response?.status) &&
          !originalRequest._retry &&
          !this._fetchingAuth &&
          typeof this.setAuth === "function"
        ) {
          try {
            this._fetchingAuth = true;
            await this.setAuth();
            await this.farmer.save();

            originalRequest._retry = true;
            originalRequest.headers = {
              ...originalRequest.headers,
              ...this.farmer.headers,
              ...this.getExtraHeaders?.(),
            };

            return this.api.request(originalRequest);
          } catch (error) {
            console.error("Failed to refresh auth:", error);
            return Promise.reject(error);
          } finally {
            this._fetchingAuth = false;
          }
        }

        return Promise.reject(error);
      }
    );

    /** Log API Response */
    if (process.env.NODE_ENV !== "production") {
      this.api.interceptors.response.use(
        (response) => {
          const url = response.config.url;
          const title = utils.truncateAndPad(this.farmer.account.id, 10);
          const status = utils.truncateAndPad(response.status, 3);
          const method = utils.truncateAndPad(
            response.config.method.toUpperCase(),
            4
          );

          /** Log to Console */
          console.log(
            `${chalk.bold.blue(`${title}`)} ${chalk.bold.cyan(
              `${method}`
            )} ${chalk.bold.green(`${status} ${url}`)}`
          );
          return response;
        },
        (error) => {
          const url = error.config.url;
          const title = utils.truncateAndPad(this.farmer.account.id, 10);
          const status = utils.truncateAndPad(
            error.response?.status ?? "ERR",
            3
          );
          const method = utils.truncateAndPad(
            error.config.method.toUpperCase(),
            4
          );

          /** Log to Console */
          console.log(
            `${chalk.bold.blue(`${title}`)} ${chalk.bold.cyan(
              `${method}`
            )} ${chalk.bold.red(`${status} ${url}`)}`
          );
          return Promise.reject(error);
        }
      );
    }

    /** Register extra interceptors */
    if (this.configureApi) {
      this.configureApi();
    }
  }

  /** Log Task Error */
  logTaskError(task, error) {
    console.error(
      "Failed to complete task:",
      this.farmer.accountId,
      task,
      this.wrapError(error)
    );
  }

  /** Wrap Error */
  wrapError(error) {
    return isAxiosError(error)
      ? error.response?.data || error.message
      : error.message;
  }

  /** Validate Telegram Task */
  validateTelegramTask(link) {
    return !utils.isTelegramLink(link) || this.canJoinTelegramLink(link);
  }

  /** Can Join Telegram Link */
  canJoinTelegramLink(link) {
    return utils.canJoinTelegramLink(link) && Boolean(this.client);
  }

  /** Join Telegram Link */
  joinTelegramLink(link) {
    return this.client.joinTelegramLink(link);
  }

  /** Try to join Telegram Link */
  async tryToJoinTelegramLink(link) {
    if (this.canJoinTelegramLink(link)) {
      try {
        await this.joinTelegramLink(link);
      } catch (error) {
        console.error(error);
      }
    }
  }

  async init() {
    /** Update WebAppData */
    if (this.farmer.account.session) {
      try {
        this.client = await GramClient.create(this.farmer.account.session);
        await this.client.connect();
        await this.updateWebAppData();
      } catch {
        console.error("Failed to update WebAppData");
      }
    }

    /** Set Auth */
    if (this.constructor.auth) {
      await this.setAuth();
    }

    /** Save Farmer */
    if (this.farmer.changed()) {
      await this.farmer.save();
    }

    return this;
  }

  async updateWebAppData() {
    const { url } = await this.client.webview(this.config.telegramLink);
    const { initData } = utils.extractTgWebAppData(url);

    this.farmer.initData = initData;
  }

  async disconnect() {
    try {
      if (!this.farmer.account.session) {
        this.farmer.active = false;
        await this.farmer.save();
      }
    } catch (error) {
      this.constructor.error("Error:", error);
    }
  }

  async process() {
    throw new Error("process() must be implemented by subclass");
  }

  static log(msg, ...args) {
    console.log(`[${this.title}] ${msg}`, ...args);
  }

  static error(msg, ...args) {
    console.error(`[${this.title}] ${msg}`, ...args);
  }

  static async farm(config, farmer) {
    const instance = new this(config, farmer);

    try {
      await instance.init();
      await instance.process();
    } catch (error) {
      await instance.disconnect();
      this.error(
        "Error:",
        farmer.accountId,
        isAxiosError(error)
          ? error?.response?.data || error.message
          : error.message
      );
    }
  }

  static async run(config) {
    this.log("Starting Farmer");

    /** Currently Running */
    if (this._isRunning) {
      this.log("Skipping run because previous run is still in progress.");
      return;
    }

    /** Mark as Running */
    this._isRunning = true;

    try {
      /** Start Date */
      const startDate = new Date();

      /** Retrieve active farmers */
      const farmers = await db.Farmer.findAllWithActiveSubscription({
        where: {
          farmer: config.id,
          active: true,
        },
      });

      /** Run all farmer */
      await Promise.allSettled(
        farmers.map((farmer) => this.farm(config, farmer))
      );

      /** Send Farming Complete Message */
      try {
        await bot?.sendFarmingCompleteMessage({
          id: this.id,
          title: this.title,
          farmers: await db.Farmer.findAllWithActiveSubscription({
            where: {
              farmer: this.id,
            },
          }),
          config,
          startDate,
          endDate: new Date(),
        });
      } catch (error) {
        this.error("Failed to send farming notification:", error);
      }
    } catch (error) {
      this.error("Error during run:", error);
    } finally {
      this._isRunning = false;
      this.log("Completed Farming!");
    }
  }
}

module.exports = BaseFarmer;
