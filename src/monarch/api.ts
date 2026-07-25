/**
 * Monarch Money GraphQL client.
 *
 * Ported from the local stdio server (~/Code/tools/monarch-mcp/src/monarch-api.ts).
 * The queries and response shapes are unchanged; the only difference is that the
 * session-token cache now resolves through ./tokenStore.js so it can live on a
 * Railway volume instead of the home directory.
 */
import axios from 'axios';
import { GraphQLClient } from 'graphql-request';
import * as crypto from 'node:crypto';
import { loadCachedToken, saveCachedToken } from './tokenStore.js';

// ---- TOTP (RFC 6238), implemented with Node crypto so there are no extra deps ----
function base32Decode(b32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = b32.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function generateTOTP(secret: string, timeStepSeconds = 30, digits = 6): string {
  const key = base32Decode(secret);
  let counter = Math.floor(Date.now() / 1000 / timeStepSeconds);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

export interface LoginResponse {
  token: string;
  user: any;
  errors?: string[];
}

export interface Account {
  id: string;
  mask: string | null;
  displayName: string;
  currentBalance: number;
  includeInNetWorth: boolean;
  type: {
    name: string;
    group: string;
    display: string;
  };
  subtype: {
    name: string;
    display: string;
  };
  institution?: {
    id: string;
    name: string;
  };
}

export interface Transaction {
  id: string;
  amount: number;
  date: string;
  plaidName?: string;
  notes?: string;
  pending?: boolean;
  category?: {
    id: string;
    name: string;
  };
  merchant?: {
    id: string;
    name: string;
  };
  account: {
    id: string;
    displayName: string;
  };
}

export interface Budget {
  id: string;
  name: string;
  amount: number;
  spent: number;
  remaining: number;
}

interface Portfolio {
  performance: {
    totalValue: number;
    totalBasis: number;
    totalChangePercent: number;
    totalChangeDollars: number;
    oneDayChangePercent: number;
    historicalChart: {
      date: string;
      returnPercent: number;
    }[];
    benchmarks: {
      security: {
        id: string;
        ticker: string;
        name: string;
        oneDayChangePercent: number;
      };
      historicalChart: {
        date: string;
        returnPercent: number;
      }[];
    }[];
  };
  aggregateHoldings: {
    edges: {
      node: {
        id: string;
        quantity: number;
        basis: number;
        totalValue: number;
        securityPriceChangeDollars: number | null;
        securityPriceChangePercent: number | null;
        lastSyncedAt: string | null;
        holdings: {
          id: string;
          type: string;
          typeDisplay: string;
          name: string;
          ticker: string | null;
          closingPrice: number | null;
          closingPriceUpdatedAt: string | null;
          quantity: number;
          value: number;
          account: Account;
        }[];
        security: {
          id: string;
          name: string;
          ticker: string | null;
          currentPrice: number | null;
          currentPriceUpdatedAt: string | null;
          closingPrice: number | null;
          type: string;
          typeDisplay: string;
        };
      };
    }[];
  };
}

export class MonarchMoneyAPI {
  private static baseURL = 'https://api.monarch.com';
  private graphQLClient!: GraphQLClient;
  private token?: string;

  constructor(token?: string) {
    // Prefer a freshly-cached token, then an explicit arg / env bootstrap.
    this.token = loadCachedToken() || token || process.env.MONARCH_TOKEN;
    this.buildClient();
  }

  private buildClient(): void {
    this.graphQLClient = new GraphQLClient(
      `${MonarchMoneyAPI.baseURL}/graphql`,
      {
        headers: this.token ? { Authorization: `Token ${this.token}` } : {},
      }
    );
  }

  /** True when the server has everything it needs to log in or already holds a token. */
  isConfigured(): boolean {
    return !!this.token || this.hasCredentials();
  }

  private hasCredentials(): boolean {
    return !!(
      process.env.MONARCH_EMAIL &&
      process.env.MONARCH_PASSWORD &&
      process.env.MONARCH_TOTP_SECRET
    );
  }

  private isAuthError(error: any): boolean {
    const status = error?.response?.status;
    const msg = String(error?.message || '');
    return status === 401 || /401|unauthor/i.test(msg);
  }

  // Re-login with stored credentials + a freshly generated TOTP, then cache the new token.
  private async refreshToken(): Promise<void> {
    const email = process.env.MONARCH_EMAIL;
    const password = process.env.MONARCH_PASSWORD;
    const totpSecret = process.env.MONARCH_TOTP_SECRET;
    if (!email || !password || !totpSecret) {
      throw new Error(
        'Monarch token expired and no credentials available to refresh it. ' +
          'Set MONARCH_EMAIL, MONARCH_PASSWORD, and MONARCH_TOTP_SECRET in the MCP env so the token can self-renew.'
      );
    }
    const totp = generateTOTP(totpSecret);
    const result = await MonarchMoneyAPI.login(email, password, totp);
    this.token = result.token;
    this.buildClient();
    saveCachedToken(result.token);
    console.error('Monarch token refreshed automatically.');
  }

  // Central request path: lazily authenticate, and on an auth error refresh once and retry.
  private async request<T = any>(query: string, variables?: any): Promise<T> {
    if (!this.token && this.hasCredentials()) {
      await this.refreshToken();
    }
    try {
      return await this.graphQLClient.request<T>(query, variables);
    } catch (error: any) {
      if (this.isAuthError(error) && this.hasCredentials()) {
        await this.refreshToken();
        return await this.graphQLClient.request<T>(query, variables);
      }
      throw error;
    }
  }

  static async login(
    username: string,
    password: string,
    mfaCode?: string
  ): Promise<LoginResponse> {
    try {
      const httpClient = axios.create({
        baseURL: MonarchMoneyAPI.baseURL,
        headers: {
          'Content-Type': 'application/json',
        },
      });
      const response = await httpClient.post('/auth/login/', {
        username,
        password,
        totp: mfaCode,
        supports_mfa: true,
        trusted_device: false,
      });

      if (response.data.token) {
        return {
          token: response.data.token,
          user: response.data.user,
        };
      }

      throw new Error('Invalid credentials');
    } catch (error: any) {
      throw new Error(
        `Login failed: ${error.response?.data?.message || error.message}`
      );
    }
  }

  async getAccounts(): Promise<Account[]> {
    const query = `
          query GetAccounts {
            accounts {
              ...AccountFields
              __typename
            }
            householdPreferences {
              id
              accountGroupOrder
              __typename
            }
          }

          fragment AccountFields on Account {
            id
            displayName
            syncDisabled
            deactivatedAt
            isHidden
            isAsset
            mask
            createdAt
            updatedAt
            displayLastUpdatedAt
            currentBalance
            displayBalance
            includeInNetWorth
            hideFromList
            hideTransactionsFromReports
            includeBalanceInNetWorth
            includeInGoalBalance
            dataProvider
            dataProviderAccountId
            isManual
            transactionsCount
            holdingsCount
            manualInvestmentsTrackingMethod
            order
            logoUrl
            type {
              display
              group
              name
              __typename
            }
            subtype {
              name
              display
              __typename
            }
            credential {
              id
              updateRequired
              disconnectedFromDataProviderAt
              dataProvider
              institution {
                id
                plaidInstitutionId
                name
                status
                __typename
              }
              __typename
            }
            institution {
              id
              name
              primaryColor
              url
              __typename
            }
            __typename
          }
    `;

    try {
      const data: any = await this.request(query);
      return data.accounts || [];
    } catch (error: any) {
      if (
        error.message.includes('401') ||
        error.message.includes('unauthorized')
      ) {
        throw new Error(
          'Authentication failed. Check MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
        );
      }
      throw new Error(`Failed to get accounts: ${error.message}`);
    }
  }

  async getTransactions(
    options: {
      limit?: number;
      accountId?: string;
      startDate?: string;
      endDate?: string;
      offset?: number;
    } = {}
  ): Promise<Transaction[]> {
    const { limit = 100, accountId, startDate, endDate, offset = 0 } = options;

    const query = `
      query GetTransactionsList($offset: Int, $limit: Int, $filters: TransactionFilterInput, $orderBy: TransactionOrdering) {
        allTransactions(filters: $filters) {
          totalCount
          results(offset: $offset, limit: $limit, orderBy: $orderBy) {
            id
            amount
            pending
            date
            plaidName
            notes
            category {
              id
              name
              __typename
            }
            merchant {
              name
              id
              __typename
            }
            account {
              id
              displayName
            }
            __typename
          }
          __typename
        }
      }
    `;

    const variables: any = {
      offset,
      limit,
      filters: {},
      orderBy: 'date',
    };

    if (accountId) variables.filters.accountId = accountId;
    if (startDate) variables.filters.startDate = startDate;
    if (endDate) variables.filters.endDate = endDate;

    try {
      const data: any = await this.request(query, variables);
      return data.allTransactions?.results || [];
    } catch (error: any) {
      if (
        error.message.includes('401') ||
        error.message.includes('unauthorized')
      ) {
        throw new Error(
          'Authentication failed. Check MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
        );
      }
      throw new Error(`Failed to get transactions: ${error.message}`);
    }
  }

  async getBudgets(): Promise<Budget[]> {
    const query = `
      query Common_GetJointPlanningData($startDate: Date!, $endDate: Date!) {
        budgetSystem
        budgetData(startMonth: $startDate, endMonth: $endDate) {
          monthlyAmountsByCategory {
            category {
              id
              name
              __typename
            }
            monthlyAmounts {
              month
              plannedAmount
              actualAmount
              __typename
            }
            __typename
          }
          __typename
        }
      }
    `;

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .split('T')[0];
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString()
      .split('T')[0];

    try {
      const data: any = await this.request(query, {
        startDate,
        endDate,
      });
      const categoryData = data.budgetData?.monthlyAmountsByCategory || [];

      return categoryData.map((catData: any) => {
        const currentMonth = catData.monthlyAmounts?.find(
          (ma: any) => ma.month === startDate.substring(0, 7)
        );
        return {
          id: catData.category?.id,
          name: catData.category?.name,
          amount: currentMonth?.plannedAmount || 0,
          spent: currentMonth?.actualAmount || 0,
          remaining:
            (currentMonth?.plannedAmount || 0) -
            (currentMonth?.actualAmount || 0),
        };
      });
    } catch (error: any) {
      if (
        error.message.includes('401') ||
        error.message.includes('unauthorized')
      ) {
        throw new Error(
          'Authentication failed. Check MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
        );
      }
      throw new Error(`Failed to get budgets: ${error.message}`);
    }
  }

  async getCategories(): Promise<any[]> {
    const query = `
      query GetCategories {
        categories {
          id
          name
          systemCategory
          group {
            id
            name
          }
        }
      }
    `;

    try {
      const data: any = await this.request(query);
      return data.categories || [];
    } catch (error: any) {
      if (
        error.message.includes('401') ||
        error.message.includes('unauthorized')
      ) {
        throw new Error(
          'Authentication failed. Check MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
        );
      }
      throw new Error(`Failed to get categories: ${error.message}`);
    }
  }

  async getAccountSnapshots(
    accountId: string,
    startDate?: string,
    endDate?: string
  ): Promise<any[]> {
    let filters = `accountId: "${accountId}"`;
    if (startDate) {
      filters += `, startDate: "${startDate}"`;
    }
    if (endDate) {
      filters += `, endDate: "${endDate}"`;
    }

    const query = `
      query GetAccountSnapshots {
        accountSnapshots(filters: {${filters}}) {
          date
          balance
          signedBalance
        }
      }
    `;

    try {
      const data: any = await this.request(query);
      return data.accountSnapshots || [];
    } catch (error: any) {
      if (
        error.message.includes('401') ||
        error.message.includes('unauthorized')
      ) {
        throw new Error(
          'Authentication failed. Check MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
        );
      }
      throw new Error(`Failed to get account snapshots: ${error.message}`);
    }
  }

  async getPortfolio(startDate?: string, endDate?: string): Promise<Portfolio> {
    const query = `
      query GetPortfolio($portfolioInput: PortfolioInput) {
        portfolio(input: $portfolioInput) {
          performance {
            totalValue
            totalBasis
            totalChangePercent
            totalChangeDollars
            oneDayChangePercent
            historicalChart {
              date
              returnPercent
              __typename
            }
            benchmarks {
              security {
                id
                ticker
                name
                oneDayChangePercent
                __typename
              }
              historicalChart {
                date
                returnPercent
                __typename
              }
              __typename
            }
            __typename
          }
          aggregateHoldings {
            edges {
              node {
                id
                quantity
                basis
                totalValue
                securityPriceChangeDollars
                securityPriceChangePercent
                lastSyncedAt
                holdings {
                  id
                  type
                  typeDisplay
                  name
                  ticker
                  closingPrice
                  closingPriceUpdatedAt
                  quantity
                  value
                  account {
                    id
                    mask
                    icon
                    logoUrl
                    institution {
                      id
                      name
                      __typename
                    }
                    type {
                      name
                      display
                      __typename
                    }
                    subtype {
                      name
                      display
                      __typename
                    }
                    displayName
                    currentBalance
                    __typename
                  }
                  __typename
                }
                security {
                  id
                  name
                  ticker
                  currentPrice
                  currentPriceUpdatedAt
                  closingPrice
                  type
                  typeDisplay
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
          __typename
        }
      }
    `;

    try {
      const data: any = await this.request(query, {
        portfolioInput: { startDate, endDate },
      });
      return data.portfolio;
    } catch (error: any) {
      if (
        error.message.includes('401') ||
        error.message.includes('unauthorized')
      ) {
        throw new Error(
          'Authentication failed. Check MONARCH_EMAIL / MONARCH_PASSWORD / MONARCH_TOTP_SECRET.'
        );
      }
      throw new Error(`Failed to get portfolio: ${error.message}`);
    }
  }
}
