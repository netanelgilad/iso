import leftPad from "left-pad";
import isOdd from "is-odd";

export default async function main() {
  console.log(leftPad("loop build: is 7 odd? " + isOdd(7), 40));
}
