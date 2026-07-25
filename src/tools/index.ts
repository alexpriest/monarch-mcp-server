/**
 * The 11 read-only Monarch tools, ported unchanged from the stdio server
 * (~/Code/tools/monarch-mcp/src/tools.ts). The only structural change: the API
 * client is injected rather than constructed here, so a single long-lived
 * client (and therefore a single cached session token) is shared across the
 * per-request MCP Server instances the stateless HTTP transport creates.
 */
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MonarchMoneyAPI, Account, Transaction } from '../monarch/api.js';

export class MonarchTools {
  private api: MonarchMoneyAPI;

  constructor(api: MonarchMoneyAPI = new MonarchMoneyAPI()) {
    this.api = api;
  }

  getToolDefinitions(): Tool[] {
    return [
      {
        name: 'get_accounts',
        description: 'Get all financial accounts from Monarch Money',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_account_balance',
        description: 'Get the current balance for a specific account',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: {
              type: 'string',
              description: 'The ID of the account',
            },
          },
          required: ['accountId'],
        },
      },
      {
        name: 'get_transactions',
        description:
          'Get recent transactions, optionally filtered by account, date range, or amount',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: {
              type: 'string',
              description: 'Optional: Filter by specific account ID',
            },
            limit: {
              type: 'number',
              description:
                'Number of transactions to retrieve (default: 50, max: 500)',
              default: 50,
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format',
            },
            endDate: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format',
            },
          },
          required: [],
        },
      },
      {
        name: 'get_spending_by_category',
        description:
          'Get spending breakdown by category for a specific time period',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format',
            },
            endDate: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format',
            },
          },
          required: ['startDate', 'endDate'],
        },
      },
      {
        name: 'get_budget_summary',
        description:
          'Get current budget summary showing planned vs actual spending',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'search_transactions',
        description: 'Search transactions by description, merchant, or amount',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Search query for transaction description or merchant',
            },
            minAmount: {
              type: 'number',
              description: 'Minimum transaction amount',
            },
            maxAmount: {
              type: 'number',
              description: 'Maximum transaction amount',
            },
            limit: {
              type: 'number',
              description: 'Number of results to return (default: 50)',
              default: 50,
            },
          },
          required: [],
        },
      },
      {
        name: 'get_net_worth',
        description: 'Get current net worth and assets/liabilities breakdown',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_monthly_summary',
        description:
          'Get monthly financial summary including income, expenses, and savings',
        inputSchema: {
          type: 'object',
          properties: {
            year: {
              type: 'number',
              description: 'Year (e.g., 2024)',
            },
            month: {
              type: 'number',
              description: 'Month (1-12)',
            },
          },
          required: ['year', 'month'],
        },
      },
      {
        name: 'get_categories',
        description:
          'Get all transaction categories available in Monarch Money',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'get_account_snapshots',
        description: 'Get balance history for a specific account over time',
        inputSchema: {
          type: 'object',
          properties: {
            accountId: {
              type: 'string',
              description: 'The ID of the account',
            },
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format',
            },
            endDate: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format',
            },
          },
          required: ['accountId'],
        },
      },
      {
        name: 'get_portfolio',
        description:
          'Get current investment portfolio summary, including holdings and performance',
        inputSchema: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date in YYYY-MM-DD format',
            },
            endDate: {
              type: 'string',
              description: 'End date in YYYY-MM-DD format',
            },
          },
          required: [],
        },
      },
    ];
  }

  async executeTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'get_accounts':
        return await this.getAccounts();

      case 'get_account_balance':
        return await this.getAccountBalance(args.accountId);

      case 'get_transactions':
        return await this.getTransactions(args);

      case 'get_spending_by_category':
        return await this.getSpendingByCategory(args.startDate, args.endDate);

      case 'get_budget_summary':
        return await this.getBudgetSummary();

      case 'search_transactions':
        return await this.searchTransactions(args);

      case 'get_net_worth':
        return await this.getNetWorth();

      case 'get_monthly_summary':
        return await this.getMonthlySummary(args.year, args.month);

      case 'get_categories':
        return await this.getCategories();

      case 'get_account_snapshots':
        return await this.getAccountSnapshots(
          args.accountId,
          args.startDate,
          args.endDate
        );

      case 'get_portfolio':
        return await this.getPortfolio(args.startDate, args.endDate);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async getAccounts(): Promise<any> {
    try {
      const accounts = await this.api.getAccounts();
      return {
        success: true,
        data: accounts,
        summary: `Found ${accounts?.length || 0} accounts`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get accounts: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getAccountBalance(accountId: string): Promise<any> {
    try {
      const accounts = await this.api.getAccounts();
      const account = accounts?.find((acc: Account) => acc.id === accountId);

      if (!account) {
        throw new Error(`Account with ID ${accountId} not found`);
      }

      return {
        success: true,
        data: {
          accountId: account.id,
          accountName: account.displayName,
          currentBalance: account.currentBalance,
          accountType: account.type?.name,
          institutionName: account.institution?.name,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to get account balance: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getTransactions(args: any): Promise<any> {
    try {
      const limit = Math.min(args.limit || 50, 500);
      const options: any = { limit };

      if (args.accountId) {
        options.accountId = args.accountId;
      }
      if (args.startDate) {
        options.startDate = args.startDate;
      }
      if (args.endDate) {
        options.endDate = args.endDate;
      }

      const transactions = await this.api.getTransactions(options);

      return {
        success: true,
        data: transactions,
        summary: `Retrieved ${transactions?.length || 0} transactions`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get transactions: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getSpendingByCategory(
    startDate: string,
    endDate: string
  ): Promise<any> {
    try {
      const transactions = await this.api.getTransactions({
        startDate,
        endDate,
        limit: 5000,
      });

      const categorySpending: Record<string, number> = {};

      transactions?.forEach((transaction: Transaction) => {
        if (transaction.amount < 0) {
          // Expenses are negative
          const category = transaction.category?.name || 'Uncategorized';
          categorySpending[category] =
            (categorySpending[category] || 0) + Math.abs(transaction.amount);
        }
      });

      const sortedCategories = Object.entries(categorySpending)
        .sort(([, a], [, b]) => b - a)
        .map(([category, amount]) => ({ category, amount }));

      return {
        success: true,
        data: sortedCategories,
        summary: `Spending breakdown for ${
          Object.keys(categorySpending).length
        } categories from ${startDate} to ${endDate}`,
        totalSpent: Object.values(categorySpending).reduce(
          (sum, amount) => sum + amount,
          0
        ),
      };
    } catch (error) {
      throw new Error(
        `Failed to get spending by category: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getBudgetSummary(): Promise<any> {
    try {
      const budgets = await this.api.getBudgets();

      return {
        success: true,
        data: budgets,
        summary: `Retrieved budget information for ${
          budgets?.length || 0
        } categories`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get budget summary: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async searchTransactions(args: any): Promise<any> {
    try {
      const limit = args.limit || 50;
      const transactions = await this.api.getTransactions({ limit: 1000 }); // Get more to search through

      let filteredTransactions = transactions || [];

      if (args.query) {
        const query = args.query.toLowerCase();
        filteredTransactions = filteredTransactions.filter(
          (t: Transaction) =>
            t.plaidName?.toLowerCase().includes(query) ||
            t.notes?.toLowerCase().includes(query) ||
            t.merchant?.name?.toLowerCase().includes(query)
        );
      }

      if (args.minAmount !== undefined) {
        filteredTransactions = filteredTransactions.filter(
          (t: Transaction) => Math.abs(t.amount) >= args.minAmount
        );
      }

      if (args.maxAmount !== undefined) {
        filteredTransactions = filteredTransactions.filter(
          (t: Transaction) => Math.abs(t.amount) <= args.maxAmount
        );
      }

      const results = filteredTransactions.slice(0, limit);

      return {
        success: true,
        data: results,
        summary: `Found ${results.length} transactions matching criteria`,
      };
    } catch (error) {
      throw new Error(
        `Failed to search transactions: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getNetWorth(): Promise<any> {
    try {
      const accounts = await this.api.getAccounts();

      let totalAssets = 0;
      let totalLiabilities = 0;

      const assetAccounts: any[] = [];
      const liabilityAccounts: any[] = [];

      accounts?.forEach((account: Account) => {
        if (!account.includeInNetWorth) {
          return; // Skip accounts not included in net worth
        }

        const balance = account.currentBalance || 0;
        const accountGroup = account.type?.group?.toLowerCase() || '';

        if (accountGroup === 'asset') {
          totalAssets += balance;
          assetAccounts.push({
            name: account.displayName,
            type: account.type?.name,
            balance: balance,
          });
        } else if (accountGroup === 'liability') {
          totalLiabilities += Math.abs(balance);
          liabilityAccounts.push({
            name: account.displayName,
            type: account.type?.name,
            balance: balance,
          });
        }
      });

      const netWorth = totalAssets - totalLiabilities;

      return {
        success: true,
        data: {
          netWorth,
          totalAssets,
          totalLiabilities,
          assetAccounts,
          liabilityAccounts,
        },
        summary: `Net worth: $${netWorth.toFixed(
          2
        )} (Assets: $${totalAssets.toFixed(
          2
        )}, Liabilities: $${totalLiabilities.toFixed(2)})`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get net worth: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getMonthlySummary(year: number, month: number): Promise<any> {
    try {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      const endDate = new Date(year, month, 0).toISOString().split('T')[0]; // Last day of month

      const transactions = await this.api.getTransactions({
        startDate,
        endDate,
        limit: 5000,
      });

      let totalIncome = 0;
      let totalExpenses = 0;

      const incomeTransactions: Transaction[] = [];
      const expenseTransactions: Transaction[] = [];

      transactions?.forEach((transaction: Transaction) => {
        if (transaction.amount > 0) {
          totalIncome += transaction.amount;
          incomeTransactions.push(transaction);
        } else {
          totalExpenses += Math.abs(transaction.amount);
          expenseTransactions.push(transaction);
        }
      });

      const netSavings = totalIncome - totalExpenses;

      return {
        success: true,
        data: {
          month,
          year,
          totalIncome,
          totalExpenses,
          netSavings,
          transactionCount: transactions?.length || 0,
          incomeTransactionCount: incomeTransactions.length,
          expenseTransactionCount: expenseTransactions.length,
        },
        summary: `${year}-${month
          .toString()
          .padStart(2, '0')}: Income $${totalIncome.toFixed(
          2
        )}, Expenses $${totalExpenses.toFixed(2)}, Net $${netSavings.toFixed(
          2
        )}`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get monthly summary: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getCategories(): Promise<any> {
    try {
      const categories = await this.api.getCategories();

      return {
        success: true,
        data: categories,
        summary: `Retrieved ${categories?.length || 0} transaction categories`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get categories: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getAccountSnapshots(
    accountId: string,
    startDate?: string,
    endDate?: string
  ): Promise<any> {
    try {
      const snapshots = await this.api.getAccountSnapshots(
        accountId,
        startDate,
        endDate
      );

      return {
        success: true,
        data: snapshots,
        summary: `Retrieved ${snapshots?.length || 0} account snapshots`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get account snapshots: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  private async getPortfolio(
    startDate?: string,
    endDate?: string
  ): Promise<any> {
    try {
      const portfolio = await this.api.getPortfolio(startDate, endDate);

      return {
        success: true,
        data: portfolio,
        summary: `Retrieved portfolio summary with ${
          portfolio?.aggregateHoldings?.edges?.length || 0
        } holdings`,
      };
    } catch (error) {
      throw new Error(
        `Failed to get portfolio: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}
