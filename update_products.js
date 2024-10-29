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

// Helper function for rate limit handling
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const handleRateLimit = async (error) => {
    if (error.extensions && error.extensions.code === 'THROTTLED') {
        const retryAfter = parseInt(error.extensions.retryAfter) || 4000;
        console.log(`Rate limited! Waiting for ${retryAfter} ms before retrying...`);
        await wait(retryAfter);
    } else {
        throw error;
    }
};

// Fetch CSV products from a file
async function fetch_csv_products() {
    const products = [];
    console.log('Update file:', process.env.TO_UPDATE);

    try {
        await pipeline(
            fs.createReadStream(process.env.TO_UPDATE),
            csv(),
            new stream.Writable({
                objectMode: true,
                write(product, encoding, callback) {
                    products.push(product);
                    callback();
                },
            })
        );
    } catch (error) {
        console.log(`Error fetching products: ${error}`);
    }

    return products;
}

// GraphQL mutation to update inventory item unit cost
const updateInventoryMutation = `
    mutation inventoryItemUpdate($id: ID!, $input: InventoryItemUpdateInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem {
                id
                unitCost {
                    amount
                }
            }
            userErrors {
                field
                message
            }
        }
    }
`;

// Fetch product by SKU, checking both active and draft statuses
const fetchProductBySku = async (sku) => {
    try {
        const query = `
         {
                products(first: 1, query: "sku:${sku}") {
                    edges {
                        node {
                            id
                            title
                            handle
                            status
                            variants(first: 100) {
                                edges {
                                    node {
                                        id
                                        title
                                        sku
                                        inventoryPolicy
                                        price
                                        barcode
                                        inventoryItem {
                                            id
                                            inventoryLevels(first: 10) {
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
                    }
                }
            }
            `;

        let response = await shopify.graphql(query);

        if (response.products.edges.length === 0) {
            console.log(`SKU ${sku} not found as active. Checking drafts...`);

            const draftQuery = `
         {
                products(first: 1, query: "sku:${sku} AND status:draft") {
                    edges {
                        node {
                            id
                            title
                            handle
                            status
                            variants(first: 100) {
                                edges {
                                    node {
                                        id
                                        title
                                        sku
                                        inventoryPolicy
                                        price
                                        barcode
                                        inventoryItem {
                                            id
                                            inventoryLevels(first: 10) {
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
                    }
                }
            }
            `;
            response = await shopify.graphql(draftQuery);

            if (response.products.edges.length > 0) {
                return response.products.edges[0].node;
            } else {
                console.log(`DRAFT: SKU ${sku} not found in drafts.`);
                return null;
            }
        } else {
            return response.products.edges[0].node.variants;
        }
    } catch (error) {
        console.error(`Error fetching SKU ${sku}:`, error);
        if (error.extensions && error.extensions.code === 'THROTTLED') {
            await handleRateLimit(error);
            return fetchProductBySku(sku); // Retry after rate limit
        }
        return null;
    }
};

// Update inventory quantity and unit cost for a given SKU and size
const updateInventoryAndCost = async (sku, quantity, size, cost, updateUnitCost) => {
    try {
        const product = await fetchProductBySku(sku);
        console.log('Product:', product)
        if (!product) {
            console.log(`Product with SKU ${sku} not found.`);
            return;
        }

        console.log(`Updating SKU: ${sku}`);

        const variants = product.edges;
        console.log(variants)

        for (const variantEdge of variants) {
            const variant = variantEdge.node;
            const sizeOption = variant.title;

            if (sizeOption === size) {
                const inventoryItemId = variant.inventoryItem.id;
                const inventoryLevelId = variant.inventoryItem.inventoryLevels.edges[0]?.node.id;
                const currentQty = variant.inventoryItem.inventoryLevels.edges[0]?.node.available || 0;
                const deltaQty = parseInt(quantity) - parseInt(currentQty);
                if (deltaQty === 0) {
                    console.log(`No quantity update needed for SKU ${sku}, Size ${size}.`);
                    continue;
                }

                const mutation = `
                mutation {
                    inventoryAdjustQuantity(input: {
                        inventoryLevelId: "${inventoryLevelId}",
                        availableDelta: ${deltaQty}
                    }) {
                        inventoryLevel {
                            id
                            available
                        }
                        userErrors {
                            field
                            message
                        }
                    }
                }`;

                await shopify.graphql(mutation);
                console.log(`Updated quantity for SKU ${sku}, Size ${size}.`);
            }
        }

        if (updateUnitCost) {
            for (const variantEdge of variants) {
                const variant = variantEdge.node;
                const inventoryItemId = variant.inventoryItem.id;
                const existingCost = parseFloat(variant.inventoryItem.unitCost?.amount || 0);

                if (Math.abs(existingCost - cost) > 0.01) {
                    console.log(`Updating unit cost for SKU ${sku}. Old: ${existingCost}, New: ${cost}`);

                    const variables = {
                        id: inventoryItemId,
                        input: {
                            cost: parseFloat(cost) // Ensure cost is passed as a float
                        }
                    };

                    const costUpdateResponse = await shopify.graphql(updateInventoryMutation, variables);

                    if (costUpdateResponse.inventoryItemUpdate.userErrors.length > 0) {
                        console.log(`User Errors:`, costUpdateResponse.inventoryItemUpdate.userErrors);
                    } else {
                        console.log(`Unit cost for SKU ${sku} updated successfully.`);
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Error updating SKU ${sku}:`, error);
    }
};

// Main function to update inventory from the CSV
async function updateInventoryFromFetchedCSV() {
    const products = await fetch_csv_products();

    for (const product of products) {
        const sku = product["SKU"];
        const sizes = product["Size"].split(',');
        const quantities = product["Qty"].split(',');
        const unitCost = parseFloat(product["Unit Cost"]);

        if (sizes.length !== quantities.length) continue;

        for (let i = 0; i < sizes.length; i++) {
            const size = sizes[i];
            const quantity = parseInt(quantities[i]);
            const updateCost = i === 0; // Update unit cost only for the first size

            await updateInventoryAndCost(sku, quantity, size, unitCost, updateCost);
            
        }
        
    }

    console.log('Inventory update complete.');
}

// Run the update process
updateInventoryFromFetchedCSV();
