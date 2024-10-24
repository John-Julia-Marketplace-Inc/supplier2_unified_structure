const axios = require('axios');
const csv = require('csv-parser');
const Shopify = require('shopify-api-node');
// require('dotenv').config();
const stream = require('stream');
const { promisify } = require('util');
const fs = require('fs');

const pipeline = promisify(stream.pipeline);

const shopify = new Shopify({
    shopName: process.env.SHOP,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetch_csv_products(link) {
    const products = [];
    try {
        await pipeline(
            fs.createReadStream(link),
            csv(),
            new stream.Writable({
                objectMode: true,
                write(product, encoding, callback) {
                    products.push(product);
                    callback();
                }
            })
        );
    } catch (error) {
        console.log(`Error fetching products: ${error}`);
    }
    return products;
}

const updateInventoryToZero = async (sku) => {
    try {
        const query = `
        {
            productVariants(first: 100, query: "sku:${sku}") {
                edges {
                    node {
                        id
                        title
                        sku
                        inventoryItem {
                            id
                            inventoryLevels(first: 100) {
                                edges {
                                    node {
                                        id
                                        available
                                        location {
                                            name
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        `;

        const response = await shopify.graphql(query);

        if (response && response.productVariants && response.productVariants.edges.length > 0) {
            const variants = response.productVariants.edges;

            for (const variantEdge of variants) {
                const variant = variantEdge.node;
                const inventoryItemId = variant.inventoryItem.id;
                const inventoryLevelId = variant.inventoryItem.inventoryLevels.edges[0].node.id;
                const current_qty = variant.inventoryItem.inventoryLevels.edges[0].node.available;

                if (inventoryLevelId) {
                    const mutation = `
                    mutation {
                        inventoryAdjustQuantity(input: {inventoryLevelId: "${inventoryLevelId}", availableDelta: ${-current_qty}}) {
                            inventoryLevel {
                                id
                                available
                            }
                        }
                    }
                    `;
                    await shopify.graphql(mutation);
                    console.log(`Updated inventory for SKU ${variant.sku} to 0.`);
                } else {
                    console.log(`No inventory level found for SKU ${variant.sku}.`);
                }
            }
        } else {
            console.log(`SKU ${sku} not found.`);
        }

    } catch (error) {
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            console.log(`Throttled! Waiting before retrying...`);
            await wait(2000); // Wait 2 seconds before retrying
            return updateInventoryToZero(sku); // Retry the same SKU
        } else {
            console.error(`Error updating SKU ${sku}:`, error);
        }
    }

    console.log('\n=========\n');
};


async function main(products) {
    const setToZero = await fetch_csv_products(products);
    
    console.log('Number of products to update to 0:', setToZero.length);

    if (setToZero.length > 0) {
        console.log('Setting inventory to 0...')

        for (let i = 0; i < setToZero.length; i++) {
            const product = setToZero[i];
            const sku = product["SKU"];
    
            if (!sku) {
                console.log('Missing SKU in product:', product);
                continue;
            }
    
            if (sku) {
                await updateInventoryToZero(sku);
            }
        }
    }
}

// Run the script
console.log('Zero inventory path:', process.env.ZERO_INVENTORY)
main(process.env.ZERO_INVENTORY);