const fs = require('fs');
const csv = require('csv-parser');
// require('dotenv').config();
const stream = require('stream');
const { promisify } = require('util');
const Shopify = require('shopify-api-node');

const pipeline = promisify(stream.pipeline);

const shopify = new Shopify({
    shopName: process.env.SHOP,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

async function fetch_csv(filePath) {
    const products = [];
    try {
        await pipeline(
            fs.createReadStream(filePath),
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
        console.log(`Error fetching products from ${filePath}: ${error}`);
    }
    return products;
}

function create_variants(product) {
    const sizes = product["Size"] ? product["Size"].split(',') : [];
    const qtyDetails = product["Qty"] ? product["Qty"].split(',') : [];
    const barcodes = product["Barcode"] ? product["Barcode"].split(',') : [];

    const variants = sizes.map((size, index) => ({
        option1: size,
        price: product["Retail Price"],
        compare_at_price: product["Compare To Price"],
        sku: `${product["SKU"]}`,
        requires_shipping: true,
        inventory_quantity: parseInt(qtyDetails[index], 10) || 0,
        inventory_management: "shopify",
        inventory_policy: "deny",
        barcode: barcodes[index] ? barcodes[index].trim() : '',
        taxable: true,
        cost: product["Unit Cost"],
    }));

    return {
        option1: 'Size',  // Set the option name to "Size"
        variants: variants,
    };
}


async function add_products(products) {
    console.log('Starting product creation...');

    for (const product of products) {
        if (!product["Product Title"] || product['Clean Images'].length === 0) {
            console.error('Product title is undefined OR missing images, skipping this product:', product['Sku Styleisnow']);
            continue;
        }

        if (product['Inventory'] == 'OUT OF STOCK') {
            console.log('Skipping out of stock product:', product['SKU'])
            continue
        }

        const formattedTitle = product["Product Title"]
            .replace(/['"]/g, '')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

        const handle = formattedTitle.toLowerCase().replace(/\s+/g, '-');

        const { option1, variants } = create_variants(product);

        const metafields = [
            { namespace: 'category', key: 'details', value: product['Material'], type: 'multi_line_text_field' },
            { namespace: 'custom', key: 'made_in', value: product['Country'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'color', value: product['Color detail'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'color_detail', value: product['Color Supplier'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'season', value: product['Season'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'dimensions', value: product['Dimensions'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'year', value: product['Year'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'bag_length', value: product['Bag length'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'bag_height', value: product['Bag height'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'bag_width', value: product['Bag width'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'accessory_height', value: product['Accessory height'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'accessory_length', value: product['Accessory length'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'heel_height', value: product['Heel height'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'fit', value: product['Fit'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'size_info', value: product['Sizing Standard'], type: 'single_line_text_field'}
        ];

        const filteredMetafields = metafields.filter(metafield => metafield.value && metafield.value !== '0' && metafield.value !== 0 && metafield.value !== '-' );


        const mutation = `
            mutation CreateProduct($input: ProductInput!) {
                productCreate(input: $input) {
                    product {
                        id
                        title
                        handle
                    }
                    userErrors {
                        field
                        message
                    }
                }
            }
        `;

        console.log(variants)

        const variables = {
            input: {
                title: formattedTitle,
                bodyHtml: product["Description"] || "No description available.",
                productType: product["Tags"],
                vendor: product["Vendor"],
                handle: handle,
                tags: product['Tags'].split(','),
                status: 'DRAFT',
                metafields: filteredMetafields,
                options: ['Size'],
            },
        };

        console.log('Variables for Shopify mutation:', JSON.stringify(variables, null, 2));

        try {
            const response = await shopify.graphql(mutation, variables);
            console.log(response)

            if (response.productCreate.userErrors.length > 0) {
                console.error('Product creation errors:', response.productCreate.userErrors);
            } else {
                console.log(`Product created successfully: ${response.productCreate.product.title}`);
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Upload media (images) after product creation
                const productId = response.productCreate.product.id;
                await upload_media(productId, product);

                // Upload variants
                console.log(`Product ID: ${productId}`);
                await upload_variants(productId, variants);
            }
        } catch (error) {
            console.error('Error creating product:', error);
            if (error.response && error.response.body) {
                console.error('Error details:', error.response.body);
            }
        }
    }
}

async function upload_variants(productId, variants) {
    const mutation = `
        mutation productVariantsBulkCreate(
            $productId: ID!, 
            $strategy: ProductVariantsBulkCreateStrategy, 
            $variants: [ProductVariantsBulkInput!]!
        ) {
            productVariantsBulkCreate(productId: $productId, strategy: $strategy, variants: $variants) {
                product {
                    id
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const variables = {
        productId: productId, // Ensure this is correctly formatted as a Shopify GID
        strategy: "REMOVE_STANDALONE_VARIANT",
        variants: variants.map((variant) => ({
            // title: variant.option1,
            optionValues: [{
                name: variant.option1,
                optionName: 'Size'
            }],
            sku: variant.sku,
            price: parseFloat(variant.price),
            compareAtPrice: variant.compare_at_price ? parseFloat(variant.compare_at_price) : null,
            taxable: true,
            inventoryItem: {
                cost: parseFloat(variant.cost) || null,
                requiresShipping: true,
                tracked: true,
            },
            inventoryQuantities: [
                {
                    locationId: process.env.LOCATION,
                    availableQuantity: parseInt(variant.inventory_quantity, 10),
                },
            ],
            inventoryPolicy: 'DENY',
        })),
    };

    try {
        const response = await shopify.graphql(mutation, variables);
        if (response.productVariantsBulkCreate.userErrors.length > 0) {
            console.error('Product variants creation errors:', response.productVariantsBulkCreate.userErrors);
        } else {
            console.log(`Product variants created successfully for product ID: ${productId}`);
        }
    } catch (error) {
        console.error('Error creating product variants:', error);
        if (error.response && error.response.body) {
            console.error('Error details:', error.response.body);
        }
    }
}


async function upload_media(productId, product) {
    const imageUrls = product["Clean Images"] ? product["Clean Images"].split(',') : [];
    const mediaInputs = imageUrls.map((url) => ({
        alt: product["Product's Title"],
        originalSource: url.trim(),
    }));

    const mutation = `
        mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
            productCreateMedia(media: $media, productId: $productId) {
                media {
                    alt
                    preview {
                        image {
                            originalSrc
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;

    const variables = {
        media: mediaInputs.map((media) => ({
            mediaContentType: "IMAGE",
            alt: media.alt,
            originalSource: media.originalSource,
        })),
        productId,
    };

    try {
        const response = await shopify.graphql(mutation, variables);
        if (response.productCreateMedia.userErrors.length > 0) {
            console.error('Media upload errors:', response.productCreateMedia.userErrors);
        } else {
            console.log(`Media uploaded successfully for product ID: ${productId}`);
        }
    } catch (error) {
        console.error('Error uploading media:', error);
        if (error.response && error.response.body) {
            console.error('Error details:', error.response.body);
        }
    }
}

async function main(filePath) {
    const productsToAdd = await fetch_csv(filePath);
    await add_products(productsToAdd);
}

main(process.env.ADD_PRODUCTS);
