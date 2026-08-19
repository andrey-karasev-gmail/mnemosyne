import { priceBox } from "./price-box";
import { labelBox } from "./label-box";

const priceResult = priceBox(19.99, 3);
const chainedTotal = priceResult.total;
const labelResult = labelBox("Ada", "Lovelace", chainedTotal);

console.log(priceResult, labelResult);
