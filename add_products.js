const fs = require('fs');
const csv = require('csv-parser');
const Shopify = require('shopify-api-node');
// require('dotenv').config();
const stream = require('stream');
const { promisify } = require('util');

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
                }
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

    const variants = sizes.map((size, index) => ({
        option1: size,
        price: product["Retail Price"],
        compare_at_price: product["Compare To Price"],
        sku: `${product["Supplier Sku"]}`,
        requires_shipping: true,
        inventory_quantity: parseInt(qtyDetails[index], 10) || 0,
        inventory_management: "shopify",
        inventory_policy: "deny",
        taxable: true,
        cost: product["Unit Cost"],
        
    }));

    return {
        option1: 'Size',  // Set the option name to "Size"
        variants: variants
    };
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));


const handleRateLimit = async (error) => {
    if (error.extensions && error.extensions.code === 'THROTTLED') {
        const retryAfter = parseInt(error.extensions.retryAfter) || 2000; // Default wait time of 2 seconds if no retryAfter is provided
        console.log(`Rate limited! Waiting for ${retryAfter} ms before retrying...`);
        await wait(retryAfter); // Wait for the time suggested by Shopify (or 2 seconds)
    } else {
        throw error; // If it's not a rate-limiting error, rethrow it
    }
};


async function add_products(product) {
    
        if (!product["Product Title"]) {
            console.error('Product title is undefined, skipping this product:', product);
            return
        }

        if (product['Inventory'] == 'OUT OF STOCK') {
            console.log('Skipping out of stock product:', product['SKU'])
            return
        }

        const formattedTitle = product["Product Title"]
            .replace(/['"]/g, '')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

        const handle = formattedTitle
            .toLowerCase()
            .replace(/\s+/g, '-');

        const { option1, variants } = create_variants(product);

        const imageUrls = product["Clean Images"] ? product["Clean Images"].split(',') : [];
        const images = imageUrls.map((url, index) => ({
            src: url.trim(),
            alt: formattedTitle,
            position: index + 1
        })).filter(image => image.src);

        // Product Title,Vendor,SKU,Supplier Sku,Original Price,Retail Price,Compare To Price,Unit Cost,Year,
        // Season,Size,Qty,Inventory,Product Category,Tags,Color detail,Color Supplier,Material,Country,Sizing Standard,Fit,Description

        const metafields = [
            { namespace: 'category', key: 'details', value: product['Material'], type: 'multi_line_text_field' },
            { namespace: 'custom', key: 'made_in', value: product['Country'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'color', value: product['Color detail'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'color_detail', value: product['Color Supplier'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'season', value: product['Season'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'year', value: product['Year'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'supplier_sku', value: product['SKU'], type: 'single_line_text_field' },
            { namespace: 'custom', key: 'size_info', value: product['Sizing Standard'], type: 'single_line_text_field'},
            { namespace: 'custom', key: 'fit', value: product['Fit'], type: 'single_line_text_field'}
        ];

        const filteredMetafields = metafields.filter(metafield => metafield.value && metafield.value !== '0' && metafield.value !== 0 && metafield.value !== '-' );

        const new_product = {
            title: formattedTitle,
            body_html: product["Description"] || "No description available.",
            vendor: product["Vendor"],
            handle: handle,
            product_type: product["Product Category"],
            published_scope: 'web',
            tags: product['Tags'].split(','),
            status: 'draft',
            images: images,
            options: [
                {
                    name: option1, 
                    values: variants.map(variant => variant.option1)
                }
            ],
            presentment_prices: {
                presentment_prices: [{
                    price: {
                        currency_code: 'USD',
                        amount: product['Retail Price']
                    },
                    compare_at_price: {
                        currency_code: 'USD',
                        amount: product['Compare to Price']
                    }
                }]
            },
            variants: variants,
            metafields: filteredMetafields
        };

        try {
            const response = await shopify.product.create(new_product);
            console.log(`Product created successfully! ${response.title}`);
        } catch (error) {
            if (error.extensions && error.extensions.code === 'THROTTLED') {
                await handleRateLimit(error);
                return add_products(product)
            } else {
                console.error(`Error updating SKU ${sku}:`, error);
            }
        }
        console.log('\n=========\n');
    
}

async function filter_products(products, nonExistentProducts) {
    const nonExistentProductCodes = new Set(nonExistentProducts.map(p => p['SKU']));
    return products.filter(product => nonExistentProductCodes.has(product["SKU"]));
}

async function main(to_add, non_existent) {
    const productsToAdd = await fetch_csv(to_add);
    const nonExistentProducts = await fetch_csv(non_existent);
    const filteredProducts = await filter_products(productsToAdd, nonExistentProducts);

    console.log('Number of products to add:', filteredProducts.length)
    
    for (const product of filteredProducts) {
        await add_products(product)
    }
}

const all_data = process.env.ALL_DATA_FILE;
const skus_to_add = process.env.OUTFILE;

console.log('All data file:', all_data);
console.log('Skus to add:', skus_to_add)

main(all_data, skus_to_add);
