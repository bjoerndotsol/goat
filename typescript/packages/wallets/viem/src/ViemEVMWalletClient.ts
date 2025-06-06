import { type EVMReadRequest, type EVMTransaction, type EVMTypedData, EVMWalletClient } from "@goat-sdk/wallet-evm";
import { type WalletClient as ViemWalletClient, encodeFunctionData, formatUnits, publicActions } from "viem";
import { mainnet } from "viem/chains";
import { eip712WalletActions, getGeneralPaymasterInput } from "viem/zksync";

export type ViemOptions = {
    paymaster?: {
        defaultAddress: `0x${string}`;
        defaultInput?: `0x${string}`;
    };
};

export class ViemEVMWalletClient extends EVMWalletClient {
    #client: ViemWalletClient;
    #defaultPaymaster: `0x${string}`;
    #defaultPaymasterInput: `0x${string}`;

    private get publicClient() {
        return this.#client.extend(publicActions);
    }

    constructor(client: ViemWalletClient, options?: ViemOptions) {
        super();
        this.#client = client;
        this.#defaultPaymaster = options?.paymaster?.defaultAddress ?? ("" as `0x${string}`);
        this.#defaultPaymasterInput =
            options?.paymaster?.defaultInput ??
            getGeneralPaymasterInput({
                innerInput: "0x",
            });
    }

    getAddress() {
        return this.#client.account?.address ?? "";
    }

    getChain() {
        return {
            type: "evm" as const,
            id: this.#client.chain?.id ?? 0,
        };
    }

    async signMessage(message: string) {
        if (!this.#client.account) throw new Error("No account connected");
        const signature = await this.#client.signMessage({
            message,
            account: this.#client.account,
        });

        return { signature };
    }

    async signTypedData(data: EVMTypedData) {
        if (!this.#client.account) throw new Error("No account connected");

        const signature = await this.#client.signTypedData({
            domain: {
                ...data.domain,
                chainId: typeof data.domain.chainId === "bigint" ? Number(data.domain.chainId) : data.domain.chainId,
            },
            types: data.types,
            primaryType: data.primaryType,
            message: data.message,
            account: this.#client.account,
        });

        return { signature };
    }

    async sendTransaction(transaction: EVMTransaction) {
        const { to, abi, functionName, args, value, options, data } = transaction;
        if (!this.#client.account) throw new Error("No account connected");

        const toAddress = to as `0x${string}`;

        const paymaster = options?.paymaster?.address ?? this.#defaultPaymaster;
        const paymasterInput = options?.paymaster?.input ?? this.#defaultPaymasterInput;
        const txHasPaymaster = !!paymaster && !!paymasterInput;

        // If paymaster params exist, extend with EIP712 actions
        const sendingClient = txHasPaymaster ? this.#client.extend(eip712WalletActions()) : this.#client;

        // Simple ETH transfer (no ABI)
        if (!abi) {
            const txParams = {
                account: this.#client.account,
                to: toAddress,
                chain: this.#client.chain,
                value,
                data,
                ...(txHasPaymaster ? { paymaster, paymasterInput } : {}),
            };

            const txHash = await sendingClient.sendTransaction(txParams);
            return this.waitForReceipt(txHash);
        }

        // Contract call
        if (!functionName) {
            throw new Error("Function name is required for contract calls");
        }

        const { request } = await this.publicClient.simulateContract({
            account: this.#client.account,
            address: toAddress,
            abi: abi,
            functionName,
            args,
            chain: this.#client.chain,
            value: value,
        });

        if (txHasPaymaster) {
            const payMasterData = encodeFunctionData({
                abi: abi,
                functionName,
                args,
            });
            // With paymaster, we must use sendTransaction() directly
            const txParams = {
                account: this.#client.account,
                chain: this.#client.chain,
                to: request.address,
                data: payMasterData,
                value: request.value,
                paymaster,
                paymasterInput,
            };
            const txHash = await sendingClient.sendTransaction(txParams);
            return this.waitForReceipt(txHash);
        }

        // Without paymaster, use writeContract which handles encoding too,
        // but since we already have request, let's let writeContract do its thing.
        // However, writeContract expects the original request format (with abi, functionName, args).
        const txHash = await this.#client.writeContract(request);
        return this.waitForReceipt(txHash);
    }

    async read(request: EVMReadRequest) {
        const { address, abi, functionName, args } = request;
        if (!abi) throw new Error("Read request must include ABI for EVM");

        const result = await this.publicClient.readContract({
            address: address as `0x${string}`,
            abi,
            functionName,
            args,
        });

        return { value: result };
    }

    async balanceOf(address: string) {
        const balance = await this.publicClient.getBalance({
            address: address as `0x${string}`,
        });

        const chain = this.#client.chain ?? mainnet;

        return {
            value: formatUnits(BigInt(balance), chain.nativeCurrency.decimals),
            decimals: chain.nativeCurrency.decimals,
            symbol: chain.nativeCurrency.symbol,
            name: chain.nativeCurrency.name,
            inBaseUnits: balance.toString(),
        };
    }

    private async waitForReceipt(txHash: `0x${string}`) {
        const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash,
        });
        return { hash: receipt.transactionHash, status: receipt.status };
    }
}

export function viem(client: ViemWalletClient, options?: ViemOptions) {
    return new ViemEVMWalletClient(client, options);
}
